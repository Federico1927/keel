import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { addDaysToKey, buildDailyJournal, dailySalesSummary, localDateKey, parseAccountingSettings, parseTenantSettings, pct, resolvePaymentFee, zonedDayStart, type AccountingSettings, type SalesSummaryDay, type SalesSummaryOrder, type TenantSettings } from "@hullwise/core";
import { MOCK_CHART_OF_ACCOUNTS } from "@hullwise/integrations";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Mapping of the demo tenant with the add-on onto the simulated chart of accounts. */
export function demoAccountingSettings(startDay: string | null): AccountingSettings {
  return parseAccountingSettings({ mapping: { sales: "4000", tax: "2200", shipping: "4090", discounts: "4900", refunds: "4910", fees: "6100", clearing: "1100", byRate: { "DE|1900": { sales: "4020", tax: "2210" }, "FR|2000": { sales: "4020", tax: "2210" }, "ES|2100": { sales: "4020", tax: "2210" } } }, startDay, lookbackDays: 35, closeDelayHours: 2, journalStatus: "draft" });
}

export function demoAccountingIntegration(tenantId: string, now: Date) {
  return { tenantId, provider: "accounting", status: "connected", mode: "mock", externalAccountId: "mock-books", externalAccountName: "Simulated accounting system", credentialsEncrypted: null, config: {}, lastSyncAt: new Date(now.getTime() - 2 * 3600e3), lastSuccessAt: new Date(now.getTime() - 2 * 3600e3) };
}

/**
 * The same order facts the summary service loads (orders placed in the range or refunded in it,
 * line weights with the taxable flag, dated refunds, actual or estimated fees), read with the seed's
 * admin connection: the seeded journals are built by the core functions the add-on uses.
 */
async function summaryOrders(db: Db, tenantId: string, tenant: { country: string; timezone: string; settings: TenantSettings }, fromDay: string, toDay: string): Promise<SalesSummaryOrder[]> {
  const from = zonedDayStart(fromDay, tenant.timezone);
  const to = zonedDayStart(addDaysToKey(toDay, 1), tenant.timezone);
  const placed = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), gte(schema.orders.placedAt, from), lt(schema.orders.placedAt, to)));
  const refunded = await db.execute<{ id: string }>(sql`select distinct order_id as id from order_events where tenant_id = ${tenantId} and created_at >= ${from} and created_at < ${to} and diff ? 'refundedMinor' union select distinct order_id from balance_transactions where tenant_id = ${tenantId} and type = 'refund' and order_id is not null and occurred_at >= ${from} and occurred_at < ${to}`);
  const ids = [...new Set([...placed.map((r) => r.id), ...refunded.rows.map((r) => r.id)])];
  if (!ids.length) return [];
  const orders = await db.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.id, ids)));
  const lines = await db.select({ orderId: schema.orderLines.orderId, quantity: schema.orderLines.quantity, unitPriceMinor: schema.orderLines.unitPriceMinor, totalMinor: schema.orderLines.totalMinor, taxable: schema.productVariants.taxable }).from(schema.orderLines).leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId)).where(and(eq(schema.orderLines.tenantId, tenantId), inArray(schema.orderLines.orderId, ids)));
  const events = await db.select({ orderId: schema.orderEvents.orderId, at: schema.orderEvents.createdAt, f: sql<string | null>`${schema.orderEvents.diff} -> 'refundedMinor' ->> 'from'`, t: sql<string | null>`${schema.orderEvents.diff} -> 'refundedMinor' ->> 'to'` }).from(schema.orderEvents).where(and(eq(schema.orderEvents.tenantId, tenantId), inArray(schema.orderEvents.orderId, ids), sql`${schema.orderEvents.diff} ? 'refundedMinor'`));
  const txns = await db.select({ orderId: schema.balanceTransactions.orderId, type: schema.balanceTransactions.type, amountMinor: schema.balanceTransactions.amountMinor, feeMinor: schema.balanceTransactions.feeMinor, at: schema.balanceTransactions.occurredAt }).from(schema.balanceTransactions).where(and(eq(schema.balanceTransactions.tenantId, tenantId), inArray(schema.balanceTransactions.orderId, ids)));
  const rates = await db.select().from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, tenantId));
  const rateFor = (c: string | null) => rates.find((r) => r.country === c) ?? rates.find((r) => r.country === tenant.country) ?? { rateBps: 0, pricesIncludeTax: true };
  return orders.map((o) => {
    const rate = rateFor(o.shippingCountry);
    const ev = events.filter((e) => e.orderId === o.id).map((e) => ({ at: e.at, amountMinor: Number(e.t ?? 0) - Number(e.f ?? 0) })).filter((e) => e.amountMinor > 0);
    const own = txns.filter((x) => x.orderId === o.id);
    const method = o.paymentMethod as keyof TenantSettings["paymentFeeBps"];
    const fee = resolvePaymentFee(pct(Math.max(0, o.totalMinor), tenant.settings.paymentFeeBps[method] ?? 0) + (tenant.settings.paymentFeeFixedMinor[method] ?? 0), own.some((x) => x.type === "charge") ? own.reduce((s, x) => s + x.feeMinor, 0) : null);
    return { id: o.id, name: o.name, placedAt: o.placedAt, status: o.status, paymentStatus: o.paymentStatus, replaced: o.replacedByOrderId !== null, country: o.shippingCountry ?? tenant.country, pricesIncludeTax: rate.pricesIncludeTax, rateBps: rate.rateBps, totalMinor: o.totalMinor, discountMinor: o.discountMinor, shippingMinor: o.shippingMinor, taxMinor: o.taxMinor, refundedMinor: o.refundedMinor, lines: lines.filter((l) => l.orderId === o.id).map((l) => ({ amountMinor: l.quantity * l.unitPriceMinor || l.totalMinor, taxable: l.taxable !== false })), refunds: ev.length ? ev : own.filter((x) => x.type === "refund").map((x) => ({ at: x.at, amountMinor: Math.abs(x.amountMinor) })), paymentMethod: o.paymentMethod, feeMinor: fee.feeMinor, feeSource: fee.source };
  });
}

/**
 * Demo rows for `addon.accounting` (issue #85) on the tenant that has it: the simulated accounting
 * system connected with its chart, the mapping, and a push log of the last 32 closed days. Every day
 * with sales is pushed except two: the latest is a failed push (rate limited, retried at the next
 * tick) and the one before waits because one of its orders has a write to the platform still
 * pending (seeded with it). One older day shows a re-push: version 1 voided, version 2 pushed; another
 * was pushed before one of its orders synced, so the reconciliation shows it no longer matches.
 */
export async function seedAccounting(db: Db, tenantId: string, now: Date): Promise<void> {
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  if (!t) return;
  const tenant = { country: t.country, timezone: t.timezone, settings: parseTenantSettings(t.settings) };
  const today = localDateKey(now, t.timezone);
  // the last closed day (two hours after local midnight) and 32 days back
  const lastClosed = now.getTime() >= zonedDayStart(today, t.timezone).getTime() + 2 * 3600e3 ? addDaysToKey(today, -1) : addDaysToKey(today, -2);
  const firstDay = addDaysToKey(lastClosed, -31);
  const settings = demoAccountingSettings(firstDay);
  await db.insert(schema.integrations).values(demoAccountingIntegration(tenantId, now)).onConflictDoNothing();
  await db.insert(schema.accountingSettings).values({ tenantId, config: settings, accounts: [...MOCK_CHART_OF_ACCOUNTS], accountsSyncedAt: new Date(now.getTime() - 2 * 3600e3) }).onConflictDoNothing();
  const facts = await summaryOrders(db, tenantId, tenant, firstDay, lastClosed);
  const summary = dailySalesSummary(facts, { timeZone: t.timezone, fromDay: firstDay, toDay: lastClosed });
  const withSales = summary.days.filter((d) => d.saleOrders > 0).map((d) => d.day).sort().reverse();
  const failedDay = withSales[0];
  const waitingDay = withSales[1];
  const repushedDay = withSales[6];
  const driftDay = withSales.slice(3).find((day) => day !== repushedDay && (summary.days.find((x) => x.day === day)?.saleOrders ?? 0) > 1);
  // the reconciliation's example: one order of this day reached Hullwise after the day was pushed
  const lateOrderId = driftDay ? summary.entries.find((e) => e.day === driftDay && e.kind === "sale")?.orderId : undefined;
  const pushedAsWas = driftDay && lateOrderId ? dailySalesSummary(facts.filter((o) => o.id !== lateOrderId), { timeZone: t.timezone, fromDay: driftDay, toDay: driftDay }).days[0] : undefined;
  const rows: (typeof schema.accountingJournals.$inferInsert)[] = [];
  let seq = 0;
  const snapshot = (s: SalesSummaryDay) => ({ totalMinor: s.totalMinor, feesMinor: s.feesMinor, netMinor: s.netMinor, taxMinor: s.taxMinor, saleOrders: s.saleOrders, refundOrders: s.refundOrders });
  // a day is pushed in the first hours after it closed
  const pushedAt = (day: string, extraHours = 0) => new Date(Math.min(now.getTime() - 60e3, zonedDayStart(addDaysToKey(day, 1), t.timezone).getTime() + (2.6 + extraHours) * 3600e3));
  for (const current of summary.days) {
    const d = current.day === driftDay && pushedAsWas ? pushedAsWas : current;
    const version = d.day === repushedDay ? 2 : 1;
    const { journal } = buildDailyJournal(d, settings.mapping, { currency: t.currency, version });
    const base = { tenantId, day: d.day, version, provider: "accounting_mock", currency: t.currency, journal, debitMinor: journal.debitMinor, creditMinor: journal.creditMinor, summary: snapshot(d), createdAt: pushedAt(d.day), updatedAt: pushedAt(d.day) };
    if (!journal.lines.length) {
      rows.push({ ...base, status: "empty" });
      continue;
    }
    if (d.day === failedDay) {
      rows.push({ ...base, status: "failed", attempts: 1, lastError: "[rate_limited] Mock: rate limit exceeded", lastErrorCode: "rate_limited", nextAttemptAt: new Date(now.getTime() + 30 * 60e3), updatedAt: new Date(now.getTime() - 15 * 60e3) });
      continue;
    }
    if (d.day === waitingDay) {
      const orderId = d.orderIds.find((id) => summary.entries.some((e) => e.orderId === id && e.kind === "sale" && e.day === d.day))!;
      const [o] = await db.select({ name: schema.orders.name, externalId: schema.orders.externalId, note: schema.orders.note }).from(schema.orders).where(eq(schema.orders.id, orderId));
      // the write that holds the day: a note edit Shopify throttled, retried by the outbox
      await db.insert(schema.platformWrites).values({ tenantId, provider: "shopify", kind: "order.update_details", entityType: "order", entityId: orderId, targetKey: `order:${o!.externalId}:details`, payload: { orderExternalId: o!.externalId, patch: { note: "Gift wrap, no invoice in the parcel" } }, payloadHash: "seed-accounting-note", idempotencyKey: `seed:accounting:${orderId}`, status: "pending", attempts: 2, nextAttemptAt: new Date(now.getTime() + 20 * 60e3), lastError: "[rate_limited] Throttled: retry after 20 minutes", lastErrorCode: "rate_limited", actorType: "user", startedAt: new Date(now.getTime() - 40 * 60e3), createdAt: new Date(now.getTime() - 3 * 3600e3) }).onConflictDoNothing();
      rows.push({ ...base, status: "waiting", reasons: [{ code: "orders_pending_write", count: 1, orders: [o!.name] }], updatedAt: new Date(now.getTime() - 25 * 60e3) });
      continue;
    }
    if (d.day === repushedDay) {
      const v1 = buildDailyJournal(d, settings.mapping, { currency: t.currency, version: 1 }).journal;
      rows.push({ ...base, version: 1, journal: v1, status: "voided", externalId: `mock-jnl-${String(++seq).padStart(5, "0")}-${d.day}`, externalStatus: "voided", attempts: 1, pushedAt: pushedAt(d.day), voidedAt: pushedAt(d.day, 30), note: "Refund recorded on the platform after the push" });
    }
    rows.push({ ...base, status: "pushed", externalId: `mock-jnl-${String(++seq).padStart(5, "0")}-${d.day}`, externalStatus: "draft", attempts: 1, pushedAt: pushedAt(d.day, d.day === repushedDay ? 30 : 0), payloadHash: `seed-${d.day}-v${version}` });
  }
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.accountingJournals).values(rows.slice(i, i + 200)).onConflictDoNothing();
  const lastPush = rows.filter((r) => r.status === "pushed").map((r) => r.pushedAt!.getTime()).sort((a, b) => b - a)[0] ?? now.getTime();
  await db.insert(schema.integrationHealth).values({ tenantId, source: "accounting:writes", status: "degraded", lastAttemptAt: new Date(now.getTime() - 15 * 60e3), lastSuccessAt: new Date(lastPush), consecutiveFailures: 1, rowsWrittenLast: 0, freshnessMinutes: 36 * 60, lastError: "[rate_limited] Mock: rate limit exceeded" }).onConflictDoNothing();
}
