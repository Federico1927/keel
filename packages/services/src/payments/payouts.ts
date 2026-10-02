import { and, desc, eq, gte, inArray, lt, schema, sql } from "@hullwise/db";
import { payoutTotals, type PayoutTotals } from "@hullwise/core";
import type { CommercePlatform, NormalizedBalanceTransaction, NormalizedPayout } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { recordHealth } from "../sync";

/* ---------- import: resumable payouts sync ---------- */

interface PayoutsCursor {
  since: string;
  /** Platform cursor of the payouts list; null once every page was read. */
  payoutCursor: string | null;
  payoutsDone: boolean;
  /** Payouts whose balance transactions are still to read, with the transaction cursor of the first one. */
  pending: string[];
  txnCursor: string | null;
  /** Latest payout date seen: the next delta starts a week before it (pending payouts are restated). */
  highWaterMark: string | null;
}

const DAY = 864e5;
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

async function upsertPayout(ctx: ServiceContext, provider: string, p: NormalizedPayout, now: Date): Promise<void> {
  const values = { status: p.status, issuedAt: p.issuedAt, currency: p.currency, grossMinor: p.grossMinor, refundsMinor: p.refundsMinor, adjustmentsMinor: p.adjustmentsMinor, feeMinor: p.feeMinor, netMinor: p.netMinor, syncedAt: now, updatedAt: now };
  await ctx.tx.insert(schema.payouts).values({ tenantId: ctx.tenantId, provider, externalId: p.externalId, ...values }).onConflictDoUpdate({ target: [schema.payouts.tenantId, schema.payouts.provider, schema.payouts.externalId], set: values });
}

/** Stores a page of balance transactions, linked to their payout and (by external id) to Hullwise's orders. */
async function upsertTransactions(ctx: ServiceContext, provider: string, payoutExternalId: string, items: NormalizedBalanceTransaction[], now: Date): Promise<number> {
  if (!items.length) return 0;
  const [payout] = await ctx.tx.select({ id: schema.payouts.id }).from(schema.payouts).where(and(eq(schema.payouts.tenantId, ctx.tenantId), eq(schema.payouts.provider, provider), eq(schema.payouts.externalId, payoutExternalId))).limit(1);
  const orderExt = [...new Set(items.map((t) => t.orderExternalId).filter((x): x is string => Boolean(x)))];
  const orders = orderExt.length ? await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.externalId, orderExt))) : [];
  const orderId = new Map(orders.map((o) => [o.externalId!, o.id]));
  for (const t of items) {
    const values = { payoutId: payout?.id ?? null, payoutExternalId: t.payoutExternalId ?? payoutExternalId, type: t.type, orderId: t.orderExternalId ? (orderId.get(t.orderExternalId) ?? null) : null, orderExternalId: t.orderExternalId, amountMinor: t.amountMinor, feeMinor: t.feeMinor, netMinor: t.netMinor, currency: t.currency, occurredAt: t.occurredAt, syncedAt: now };
    await ctx.tx.insert(schema.balanceTransactions).values({ tenantId: ctx.tenantId, provider, externalId: t.externalId, ...values }).onConflictDoUpdate({ target: [schema.balanceTransactions.tenantId, schema.balanceTransactions.provider, schema.balanceTransactions.externalId], set: values });
  }
  return items.length;
}

/**
 * Imports payouts and their balance transactions (actual fees) like the other syncs: one
 * `sync_runs` row per pass, cursor saved after every page, paused at the time budget and resumed by
 * the next call. A delta re-reads from a week before the latest payout, because scheduled and
 * in-transit payouts change until they are paid; the first run goes back `days` (default 120).
 */
export async function runPayoutsSync(ctx: ServiceContext, platform: CommercePlatform, opts: { budgetMs?: number; days?: number; pageSize?: number } = {}): Promise<{ runId: string; finished: boolean; payouts: number; transactions: number; error: string | null }> {
  const now = ctx.now ?? new Date();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 20_000;
  const provider = platform.provider;
  const objectType = "payouts";
  const [paused] = await ctx.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, objectType), eq(schema.syncRuns.status, "paused"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  let cursor: PayoutsCursor;
  let runId: string;
  let written = 0;
  let scanned = 0;
  let durationBefore = 0;
  if (paused) {
    runId = paused.id;
    cursor = paused.cursor as PayoutsCursor;
    written = paused.rowsWritten;
    scanned = paused.rowsScanned;
    durationBefore = paused.durationMs ?? 0;
    await ctx.tx.update(schema.syncRuns).set({ status: "running" }).where(eq(schema.syncRuns.id, runId));
  } else {
    const [last] = await ctx.tx.select({ cursor: schema.syncRuns.cursor }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, objectType), eq(schema.syncRuns.status, "success"))).orderBy(desc(schema.syncRuns.finishedAt)).limit(1);
    const hwm = (last?.cursor as PayoutsCursor | undefined)?.highWaterMark ?? null;
    const since = hwm ? new Date(new Date(hwm).getTime() - 7 * DAY) : new Date(now.getTime() - (opts.days ?? 120) * DAY);
    cursor = { since: since.toISOString(), payoutCursor: null, payoutsDone: false, pending: [], txnCursor: null, highWaterMark: hwm };
    const [run] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType, kind: hwm ? "delta" : "initial", status: "running", cursor, startedAt: now }).returning({ id: schema.syncRuns.id });
    runId = run!.id;
  }
  let payoutsSeen = 0;
  let txnsSeen = 0;
  const stats = () => ({ rowsWritten: written, rowsScanned: scanned, durationMs: durationBefore + (Date.now() - started) });
  const save = () => ctx.tx.update(schema.syncRuns).set({ cursor, ...stats() }).where(eq(schema.syncRuns.id, runId));
  const pause = async () => {
    await ctx.tx.update(schema.syncRuns).set({ status: "paused", cursor, ...stats() }).where(eq(schema.syncRuns.id, runId));
    return { runId, finished: false, payouts: payoutsSeen, transactions: txnsSeen, error: null };
  };
  try {
    while (!cursor.payoutsDone) {
      const page = await platform.fetchPayouts({ createdSince: new Date(cursor.since), cursor: cursor.payoutCursor, limit: opts.pageSize ?? 50 });
      for (const p of page.items) {
        await upsertPayout(ctx, provider, p, now);
        if (!cursor.pending.includes(p.externalId)) cursor.pending.push(p.externalId);
        if (!cursor.highWaterMark || p.issuedAt.toISOString() > cursor.highWaterMark) cursor.highWaterMark = p.issuedAt.toISOString();
      }
      payoutsSeen += page.items.length;
      scanned += page.items.length;
      written += page.items.length;
      cursor = { ...cursor, payoutCursor: page.nextCursor, payoutsDone: !page.nextCursor };
      await save();
      if (!cursor.payoutsDone && Date.now() - started > budgetMs) return await pause();
    }
    while (cursor.pending.length) {
      const payoutExternalId = cursor.pending[0]!;
      const page = await platform.fetchBalanceTransactions({ payoutExternalId, cursor: cursor.txnCursor, limit: opts.pageSize ? opts.pageSize * 2 : 100 });
      const n = await upsertTransactions(ctx, provider, payoutExternalId, page.items, now);
      txnsSeen += n;
      scanned += n;
      written += n;
      if (page.nextCursor) cursor = { ...cursor, txnCursor: page.nextCursor };
      else {
        await ctx.tx.update(schema.payouts).set({ transactionCount: sql`(select count(*)::int from balance_transactions b where b.tenant_id = ${ctx.tenantId} and b.payout_id = ${schema.payouts.id})` }).where(and(eq(schema.payouts.tenantId, ctx.tenantId), eq(schema.payouts.provider, provider), eq(schema.payouts.externalId, payoutExternalId)));
        cursor = { ...cursor, pending: cursor.pending.slice(1), txnCursor: null };
      }
      await save();
      if (cursor.pending.length && Date.now() - started > budgetMs) return await pause();
    }
    await ctx.tx.update(schema.syncRuns).set({ status: "success", cursor, ...stats(), finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
    await recordHealth(ctx, `${provider}:payouts`, true, { rowsWritten: written, freshnessMinutes: 24 * 60, touchIntegration: false });
    return { runId, finished: true, payouts: payoutsSeen, transactions: txnsSeen, error: null };
  } catch (e) {
    const error = errMessage(e);
    await ctx.tx.update(schema.syncRuns).set({ status: "error", error, cursor, ...stats(), errorCount: 1, finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
    await recordHealth(ctx, `${provider}:payouts`, false, { error, touchIntegration: false });
    return { runId, finished: false, payouts: payoutsSeen, transactions: txnsSeen, error };
  }
}

/* ---------- read models: payouts page ---------- */

export interface PayoutFilters {
  status?: string;
  from?: string;
  to?: string;
  page?: number;
}
export const PAYOUTS_PAGE_SIZE = 30;

export async function listPayouts(ctx: ServiceContext, f: PayoutFilters = {}) {
  const conds = [eq(schema.payouts.tenantId, ctx.tenantId)];
  if (f.status) conds.push(eq(schema.payouts.status, f.status));
  if (f.from) conds.push(gte(schema.payouts.issuedAt, new Date(f.from)));
  if (f.to) conds.push(lt(schema.payouts.issuedAt, new Date(new Date(f.to).getTime() + DAY)));
  const where = and(...conds);
  const page = Math.max(1, f.page ?? 1);
  const rows = await ctx.tx.select().from(schema.payouts).where(where).orderBy(desc(schema.payouts.issuedAt)).limit(PAYOUTS_PAGE_SIZE).offset((page - 1) * PAYOUTS_PAGE_SIZE);
  const [totals] = await ctx.tx.select({ count: sql<number>`count(*)::int`, grossMinor: sql<number>`coalesce(sum(${schema.payouts.grossMinor}), 0)::bigint`, refundsMinor: sql<number>`coalesce(sum(${schema.payouts.refundsMinor}), 0)::bigint`, adjustmentsMinor: sql<number>`coalesce(sum(${schema.payouts.adjustmentsMinor}), 0)::bigint`, feeMinor: sql<number>`coalesce(sum(${schema.payouts.feeMinor}), 0)::bigint`, netMinor: sql<number>`coalesce(sum(${schema.payouts.netMinor}), 0)::bigint` }).from(schema.payouts).where(where);
  const [run] = await ctx.tx.select({ status: schema.syncRuns.status, finishedAt: schema.syncRuns.finishedAt, startedAt: schema.syncRuns.startedAt, error: schema.syncRuns.error }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.objectType, "payouts"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  const n = (v: unknown) => Number(v ?? 0);
  return { rows, page, pageSize: PAYOUTS_PAGE_SIZE, total: n(totals?.count), totals: { grossMinor: n(totals?.grossMinor), refundsMinor: n(totals?.refundsMinor), adjustmentsMinor: n(totals?.adjustmentsMinor), feeMinor: n(totals?.feeMinor), netMinor: n(totals?.netMinor) }, lastRun: run ?? null };
}

export interface PayoutDetail {
  payout: typeof schema.payouts.$inferSelect;
  transactions: (typeof schema.balanceTransactions.$inferSelect & { orderName: string | null; orderPlacedAt: Date | null; paymentMethod: string | null })[];
  /** Totals recomputed from the transactions: they match the payout when every transaction was imported. */
  computed: PayoutTotals;
  matches: boolean;
  /** Orders in the deposit, by role. */
  orders: { charged: number; refunded: number; unmatched: number };
}

/** One deposit with its orders, fees, refunds and net. */
export async function payoutDetail(ctx: ServiceContext, payoutId: string): Promise<PayoutDetail | null> {
  const [payout] = await ctx.tx.select().from(schema.payouts).where(and(eq(schema.payouts.tenantId, ctx.tenantId), eq(schema.payouts.id, payoutId))).limit(1);
  if (!payout) return null;
  const rows = await ctx.tx
    .select({ t: schema.balanceTransactions, orderName: schema.orders.name, orderPlacedAt: schema.orders.placedAt, paymentMethod: schema.orders.paymentMethod })
    .from(schema.balanceTransactions)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.balanceTransactions.orderId))
    .where(and(eq(schema.balanceTransactions.tenantId, ctx.tenantId), eq(schema.balanceTransactions.payoutId, payout.id)))
    .orderBy(schema.balanceTransactions.occurredAt, schema.balanceTransactions.externalId);
  const transactions = rows.map((r) => ({ ...r.t, orderName: r.orderName, orderPlacedAt: r.orderPlacedAt, paymentMethod: r.paymentMethod }));
  const computed = payoutTotals(transactions);
  return {
    payout,
    transactions,
    computed,
    matches: computed.grossMinor === payout.grossMinor && computed.refundsMinor === payout.refundsMinor && computed.adjustmentsMinor === payout.adjustmentsMinor && computed.feesMinor === payout.feeMinor && computed.netMinor === payout.netMinor,
    orders: { charged: new Set(transactions.filter((t) => t.type === "charge" && t.orderId).map((t) => t.orderId)).size, refunded: new Set(transactions.filter((t) => t.type === "refund" && t.orderId).map((t) => t.orderId)).size, unmatched: transactions.filter((t) => t.orderExternalId && !t.orderId).length },
  };
}

/** Balance transactions of one order (order page): the actual fee and the deposits it went into. */
export async function orderBalanceTransactions(ctx: ServiceContext, orderId: string) {
  return ctx.tx
    .select({ id: schema.balanceTransactions.id, type: schema.balanceTransactions.type, amountMinor: schema.balanceTransactions.amountMinor, feeMinor: schema.balanceTransactions.feeMinor, netMinor: schema.balanceTransactions.netMinor, occurredAt: schema.balanceTransactions.occurredAt, payoutId: schema.balanceTransactions.payoutId, payoutStatus: schema.payouts.status, payoutIssuedAt: schema.payouts.issuedAt })
    .from(schema.balanceTransactions)
    .leftJoin(schema.payouts, eq(schema.payouts.id, schema.balanceTransactions.payoutId))
    .where(and(eq(schema.balanceTransactions.tenantId, ctx.tenantId), eq(schema.balanceTransactions.orderId, orderId)))
    .orderBy(schema.balanceTransactions.occurredAt);
}
