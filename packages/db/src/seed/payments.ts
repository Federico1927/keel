import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { PROCESSOR_GATEWAYS, buildMockPayouts } from "@keel/integrations";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
/** Same window as the mock adapter (`MOCK_PAYOUT_DAYS` in services): a sync of the demo finds the same payouts. */
const PAYOUT_DAYS = 100;

/**
 * Shopify Payments payouts of the last months for a demo store (issue #27), built by the same
 * deterministic generator as the mock adapter: card and wallet orders paid through the processor
 * get their actual fee, PayPal, BNPL, transfers and cash keep the estimate. A finished sync run is
 * recorded so the next delta starts from the latest payout. Paid bank transfers of the last 30 days
 * get the manual payment the operations team recorded, and three delivered card orders a goodwill
 * refund of 10% issued from the order page (before the payouts are built, so they include it).
 */
export async function seedPayments(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  await db.delete(schema.balanceTransactions).where(eq(schema.balanceTransactions.tenantId, tenantId));
  await db.delete(schema.payouts).where(eq(schema.payouts.tenantId, tenantId));
  const [tenant] = await db.select({ currency: schema.tenants.currency }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const dom = key === "northwind" ? "northwind" : "harborhome";
  const ops = userIds[`ops@${dom}.demo`] ?? null;
  const care = userIds[key === "northwind" ? "care@northwind.demo" : "owner@harborhome.demo"] ?? ops;
  const processor = sql.raw(`array[${PROCESSOR_GATEWAYS.map((g) => `'${g}'`).join(",")}]::text[]`);
  // goodwill refunds of 10% on three delivered card orders, six days after the order
  await db.execute(sql`
    with picked as (
      select id, currency, total_minor, round(total_minor * 0.1)::int as amount, placed_at + interval '6 days' as at, row_number() over (order by abs(hashtext(id::text || 'goodwill'))) as n
      from orders where tenant_id = ${tenantId} and status = 'delivered' and payment_method = 'card' and payment_status = 'paid' and refunded_minor = 0 and external_id is not null
        and payment_gateways && ${processor} and placed_at between ${new Date(now.getTime() - 60 * DAY)} and ${new Date(now.getTime() - 15 * DAY)}
      order by abs(hashtext(id::text || 'goodwill')) limit 3
    ),
    upd as (update orders o set refunded_minor = p.amount, payment_status = 'partially_refunded', financial_status_raw = 'partially_refunded' from picked p where o.id = p.id returning o.id),
    tx as (
      insert into order_transactions (tenant_id, order_id, kind, amount_minor, currency, method, occurred_at, note, external_id, written_to_platform, actor_user_id, actor_type, created_at)
      select ${tenantId}, p.id, 'refund', p.amount, p.currency, 'card', p.at, ${key === "northwind" ? "Gesto commerciale: consegna in ritardo" : "Goodwill: late delivery"}, 'mock-refund-seed-' || p.n, true, ${care}, 'user', p.at from picked p join upd on upd.id = p.id
      returning id, order_id, amount_minor, occurred_at, note
    )
    insert into order_events (tenant_id, order_id, type, actor_user_id, actor_type, diff, metadata, created_at)
    select ${tenantId}, tx.order_id, 'refund_issued', ${care}, 'user', jsonb_build_object('refundedMinor', jsonb_build_object('from', 0, 'to', tx.amount_minor), 'paymentStatus', jsonb_build_object('from', 'paid', 'to', 'partially_refunded')),
      jsonb_build_object('amountMinor', tx.amount_minor, 'requestedMinor', tx.amount_minor, 'lines', '[]'::jsonb, 'restocked', 0, 'note', tx.note, 'transactionId', tx.id, 'platform', 'shopify'), tx.occurred_at
    from tx`);
  const rows = (
    await db.execute<{ id: string; external_id: string; placed_at: string | Date; total_minor: number; refunded_minor: number; payment_status: string; cancelled_at: string | Date | null; refunded_at: string | Date | null; payment_gateways: string[] }>(sql`
      select o.id, o.external_id, o.placed_at, o.total_minor, o.refunded_minor, o.payment_status, o.cancelled_at, o.payment_gateways,
        (select min(t.occurred_at) from order_transactions t where t.order_id = o.id and t.kind = 'refund') as refunded_at
      from orders o
      where o.tenant_id = ${tenantId} and o.external_id is not null and o.placed_at >= ${new Date(now.getTime() - PAYOUT_DAYS * DAY)}
        and o.payment_status in ('paid', 'partially_refunded', 'refunded') and o.payment_gateways && ${processor}`)
  ).rows;
  const at = (v: string | Date | null) => (v ? new Date(v) : null);
  const { payouts, transactions } = buildMockPayouts({ orders: rows.map((o) => ({ externalId: o.external_id, placedAt: new Date(o.placed_at), totalMinor: o.total_minor, refundedMinor: o.payment_status === "refunded" ? o.total_minor : o.refunded_minor, refundedAt: at(o.cancelled_at) ?? at(o.refunded_at), gateways: o.payment_gateways })), currency: tenant!.currency, now });
  if (payouts.length) {
    const inserted = await db.insert(schema.payouts).values(payouts.map((p) => ({ tenantId, provider: "shopify", externalId: p.externalId, status: p.status, issuedAt: p.issuedAt, currency: p.currency, grossMinor: p.grossMinor, refundsMinor: p.refundsMinor, adjustmentsMinor: p.adjustmentsMinor, feeMinor: p.feeMinor, netMinor: p.netMinor, transactionCount: transactions.filter((t) => t.payoutExternalId === p.externalId).length, syncedAt: now, createdAt: now, updatedAt: now }))).returning({ id: schema.payouts.id, externalId: schema.payouts.externalId });
    const payoutId = new Map(inserted.map((p) => [p.externalId, p.id]));
    const orderId = new Map(rows.map((o) => [o.external_id, o.id]));
    const values = transactions.map((t) => ({ tenantId, provider: "shopify", externalId: t.externalId, payoutId: payoutId.get(t.payoutExternalId!) ?? null, payoutExternalId: t.payoutExternalId, type: t.type, orderId: t.orderExternalId ? (orderId.get(t.orderExternalId) ?? null) : null, orderExternalId: t.orderExternalId, amountMinor: t.amountMinor, feeMinor: t.feeMinor, netMinor: t.netMinor, currency: t.currency, occurredAt: t.occurredAt, syncedAt: now, createdAt: now }));
    for (let i = 0; i < values.length; i += 2000) await db.insert(schema.balanceTransactions).values(values.slice(i, i + 2000));
    const hwm = payouts[0]!.issuedAt.toISOString();
    await db.insert(schema.syncRuns).values({ tenantId, provider: "shopify", objectType: "payouts", kind: "initial", status: "success", cursor: { since: new Date(now.getTime() - PAYOUT_DAYS * DAY).toISOString(), payoutCursor: null, payoutsDone: true, pending: [], txnCursor: null, highWaterMark: hwm }, rowsWritten: payouts.length + transactions.length, rowsScanned: payouts.length + transactions.length, durationMs: 4200, startedAt: new Date(now.getTime() - 3 * 36e5), finishedAt: new Date(now.getTime() - 3 * 36e5 + 4200) });
  }
  // manual payments: the bank transfers of the last 30 days that arrived, recorded by operations
  await db.execute(sql`
    with paid as (
      select id, currency, total_minor, placed_at + make_interval(hours => 20 + abs(hashtext(id::text)) % 40) as at
      from orders where tenant_id = ${tenantId} and payment_method = 'bank_transfer' and payment_status in ('paid', 'partially_refunded', 'refunded')
        and placed_at >= ${new Date(now.getTime() - 30 * DAY)} and placed_at < ${new Date(now.getTime() - 3 * DAY)}
    ),
    tx as (
      insert into order_transactions (tenant_id, order_id, kind, amount_minor, currency, method, occurred_at, note, written_to_platform, actor_user_id, actor_type, created_at)
      select ${tenantId}, id, 'manual_payment', total_minor, currency, 'bank_transfer', at, null, true, ${ops}, 'user', at from paid
      returning id, order_id, amount_minor, occurred_at
    )
    insert into order_events (tenant_id, order_id, type, actor_user_id, actor_type, diff, metadata, created_at)
    select ${tenantId}, order_id, 'payment_recorded', ${ops}, 'user', jsonb_build_object('paymentStatus', jsonb_build_object('from', 'pending', 'to', 'paid')),
      jsonb_build_object('amountMinor', amount_minor, 'method', 'bank_transfer', 'occurredAt', to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'outstandingMinor', 0, 'transactionId', id, 'platform', 'outbox'), occurred_at
    from tx`);
}
