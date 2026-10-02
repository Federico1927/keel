import { and, asc, eq, inArray, isNotNull, schema, sql } from "@hullwise/db";
import {
  SALE_STATUSES,
  cancellationBreakdown,
  forecastRenewalRevenue,
  localDateKey,
  recoveryEpisodes,
  renewalSuccessRate,
  subscriberCounts,
  subscriptionLtvByAcquisition,
  subscriptionMonths,
  subscriptionMrrMovement,
  subscriptionProfit,
  subscriptionSurvivalCohorts,
  timelineMrrAt,
  type BillingAttemptFact,
  type CancellationKind,
  type MrrMovement,
  type SubscriptionPeriod,
  type SubscriptionTimeline,
} from "@hullwise/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";
import { cancellationReasons } from "./sync";

/* ---------- facts ---------- */

/**
 * Every contract as a timeline: live from activation to its end, MRR steps from the price and
 * frequency events (diff `mrrMinor`), paused intervals from the pause/resume events.
 */
export async function loadSubscriptionTimelines(ctx: ServiceContext): Promise<{ timelines: SubscriptionTimeline[]; contracts: (typeof schema.subscriptionContracts.$inferSelect)[] }> {
  const contracts = await ctx.tx.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.tenantId, ctx.tenantId));
  if (!contracts.length) return { timelines: [], contracts };
  const events = await ctx.tx.select({ contractId: schema.subscriptionEvents.contractId, type: schema.subscriptionEvents.type, diff: schema.subscriptionEvents.diff, at: schema.subscriptionEvents.occurredAt }).from(schema.subscriptionEvents).where(and(eq(schema.subscriptionEvents.tenantId, ctx.tenantId), inArray(schema.subscriptionEvents.type, ["paused", "resumed", "cancelled", "reactivated", "price_changed", "frequency_changed", "swapped"]))).orderBy(asc(schema.subscriptionEvents.occurredAt));
  const byContract = new Map<string, typeof events>();
  for (const e of events) byContract.set(e.contractId, [...(byContract.get(e.contractId) ?? []), e]);
  const timelines = contracts.map((c): SubscriptionTimeline => {
    const ev = byContract.get(c.id) ?? [];
    const step = (e: (typeof ev)[number]) => (e.diff as { mrrMinor?: { from?: unknown; to?: unknown } }).mrrMinor;
    const mrrEvents = ev.filter((e) => typeof step(e)?.to === "number");
    const first = mrrEvents[0] ? Number(step(mrrEvents[0])!.from ?? c.mrrMinor) : c.mrrMinor;
    const mrr = [{ from: c.activatedAt, mrrMinor: first }, ...mrrEvents.map((e) => ({ from: e.at, mrrMinor: Number(step(e)!.to) }))];
    const pauses: SubscriptionTimeline["pauses"] = [];
    for (const e of ev) {
      const open = pauses.at(-1);
      if (e.type === "paused" && (!open || open.to)) pauses.push({ from: e.at, to: null });
      else if ((e.type === "resumed" || e.type === "cancelled") && open && !open.to) open.to = e.at;
    }
    if (c.status === "paused" && !pauses.some((p) => !p.to)) pauses.push({ from: c.pausedAt ?? c.updatedAt, to: null });
    return { contractId: c.id, customerId: c.customerId ?? `contract:${c.id}`, activatedAt: c.activatedAt, endedAt: c.endedAt, endKind: (c.cancellationKind as CancellationKind | null) ?? null, mrr, pauses };
  });
  return { timelines, contracts };
}

export async function loadBillingAttemptFacts(ctx: ServiceContext): Promise<BillingAttemptFact[]> {
  const rows = await ctx.tx.select({ contractId: schema.subscriptionBillingAttempts.contractId, cycleKey: schema.subscriptionBillingAttempts.cycleKey, status: schema.subscriptionBillingAttempts.status, attemptedAt: schema.subscriptionBillingAttempts.attemptedAt, nextRetryAt: schema.subscriptionBillingAttempts.nextRetryAt, amountMinor: schema.subscriptionBillingAttempts.amountMinor, errorCode: schema.subscriptionBillingAttempts.errorCode }).from(schema.subscriptionBillingAttempts).where(eq(schema.subscriptionBillingAttempts.tenantId, ctx.tenantId));
  return rows.map((r) => ({ ...r, status: r.status as BillingAttemptFact["status"] }));
}

/* ---------- overview ---------- */

export interface SubscriptionsOverview {
  asOf: Date;
  period: SubscriptionPeriod;
  mrrMinor: number;
  mrrPreviousMinor: number;
  counts: ReturnType<typeof subscriberCounts>;
  previous: ReturnType<typeof subscriberCounts>;
  movement: MrrMovement[];
  cohorts: ReturnType<typeof subscriptionSurvivalCohorts>;
  successRate: number | null;
  forecast: ReturnType<typeof forecastRenewalRevenue>;
  recovery: { open: number; recovered: number; lost: number; rate: number | null; valueAtRiskMinor: number };
  currency: string;
}

/** KPIs, MRR movement by month, survival cohorts, renewal forecast and recovery for the overview page. */
export async function subscriptionsOverview(ctx: ServiceContext, tenant: AnalyticsTenant, opts: { period: SubscriptionPeriod; months?: number; asOf?: Date }): Promise<SubscriptionsOverview> {
  const asOf = opts.asOf ?? ctx.now ?? new Date();
  const { timelines, contracts } = await loadSubscriptionTimelines(ctx);
  const attempts = await loadBillingAttemptFacts(ctx);
  const len = opts.period.to.getTime() - opts.period.from.getTime();
  const prev = { from: new Date(opts.period.from.getTime() - len), to: opts.period.from };
  const success = renewalSuccessRate(attempts);
  const live = new Map(contracts.map((c) => [c.id, { live: c.status === "active" || c.status === "paused" }]));
  const rec = recoveryEpisodes(attempts, live);
  const openIds = new Set(rec.episodes.filter((e) => e.outcome === "open").map((e) => e.contractId));
  const valueAtRisk = contracts.filter((c) => openIds.has(c.id)).reduce((s, c) => s + c.priceMinor, 0);
  const at = new Date(Math.min(asOf.getTime(), opts.period.to.getTime() - 1));
  return {
    asOf,
    period: opts.period,
    mrrMinor: timelines.reduce((s, t) => s + timelineMrrAt(t, at), 0),
    mrrPreviousMinor: timelines.reduce((s, t) => s + timelineMrrAt(t, new Date(opts.period.from.getTime() - 1)), 0),
    counts: subscriberCounts(timelines, opts.period),
    previous: subscriberCounts(timelines, prev),
    movement: subscriptionMonths(asOf, opts.months ?? 12).map((m) => subscriptionMrrMovement(timelines, m)),
    cohorts: subscriptionSurvivalCohorts(timelines, asOf, { months: Math.min(12, (opts.months ?? 12) - 1), timeZone: tenant.timezone }).slice(-(opts.months ?? 12)),
    successRate: success.rate,
    forecast: forecastRenewalRevenue(contracts.map((c) => ({ status: c.status, nextBillingAt: c.nextBillingAt, intervalUnit: c.intervalUnit, intervalCount: c.intervalCount, priceMinor: c.priceMinor })), asOf, success.rate ?? 1),
    recovery: { open: rec.open, recovered: rec.recovered, lost: rec.lost, rate: rec.rate, valueAtRiskMinor: valueAtRisk },
    currency: tenant.currency,
  };
}

/** Contract ids behind an MRR movement bucket of a month (drill-down from the overview). */
export async function movementContractIds(ctx: ServiceContext, month: string, bucket: keyof MrrMovement["customers"]): Promise<string[]> {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const { timelines } = await loadSubscriptionTimelines(ctx);
  const mv = subscriptionMrrMovement(timelines, { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) });
  const customers = new Set(mv.customers[bucket] ?? []);
  return timelines.filter((t) => customers.has(t.customerId)).map((t) => t.contractId);
}

/* ---------- profit, LTV ---------- */

export interface SubscriptionProfitReport extends ReturnType<typeof subscriptionProfit> {
  acquisition: (ReturnType<typeof subscriptionLtvByAcquisition>[number] & { label: string; kind: "campaign" | "channel" })[];
}

/**
 * Profit per subscriber and per renewal from the core order economics of the orders each contract
 * created (net revenue after refunds and returns − product cost − shipping − payment fees, actual
 * fees when the processor reported them), and LTV against the acquisition cost of the campaign or
 * channel of the first subscription order (campaign spend per attributed sale order).
 */
export async function subscriptionProfitReport(ctx: ServiceContext, tenant: AnalyticsTenant, opts: { asOf?: Date } = {}): Promise<SubscriptionProfitReport> {
  const asOf = opts.asOf ?? ctx.now ?? new Date();
  // orders of contracts Hullwise still holds (the column has no foreign key: a removed contract leaves its orders unflagged in practice)
  const orders = await ctx.tx.select({ id: schema.orders.id, contractId: schema.orders.subscriptionContractId, renewal: schema.orders.renewalNumber, customerId: schema.orders.customerId, placedAt: schema.orders.placedAt }).from(schema.orders).innerJoin(schema.subscriptionContracts, eq(schema.subscriptionContracts.id, schema.orders.subscriptionContractId)).where(and(eq(schema.orders.tenantId, ctx.tenantId), isNotNull(schema.orders.subscriptionContractId)));
  const empty = { subscribers: [], byRenewal: [], totals: { orders: 0, netRevenueMinor: 0, costsMinor: 0, profitMinor: 0, avgProfitPerSubscriberMinor: null }, acquisition: [] };
  if (!orders.length) return empty;
  const from = new Date(Math.min(...orders.map((o) => o.placedAt.getTime())));
  const eco = await orderEconomicsForPeriod(ctx, tenant, { from, to: new Date(asOf.getTime() + 864e5) }, { orderIds: orders.map((o) => o.id) });
  const byId = new Map(orders.map((o) => [o.id, o]));
  const rows = eco.filter((e) => e.inScope).map((e) => {
    const o = byId.get(e.orderId)!;
    return { orderId: e.orderId, contractId: o.contractId!, customerId: o.customerId, renewalNumber: o.renewal ?? 0, netRevenueMinor: e.netRevenueMinor, cogsMinor: e.cogsMinor, shippingCostMinor: e.shippingCostMinor, paymentFeeMinor: e.paymentFeeMinor, marginMinor: e.marginMinor };
  });
  const profit = subscriptionProfit(rows);
  // acquisition: the first order's attribution (campaign when matched, else channel)
  const firstIds = orders.filter((o) => o.renewal === 0).map((o) => o.id);
  const attrs = firstIds.length ? await ctx.tx.select({ orderId: schema.orderAttribution.orderId, campaignId: schema.orderAttribution.campaignId, channel: schema.orderAttribution.channel }).from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.orderId, firstIds))) : [];
  const attrByOrder = new Map(attrs.map((a) => [a.orderId, a]));
  const firstByContract = new Map(orders.filter((o) => o.renewal === 0).map((o) => [o.contractId!, o.id]));
  const campaignIds = [...new Set(attrs.map((a) => a.campaignId).filter((x): x is string => Boolean(x)))];
  const campaigns = campaignIds.length ? await ctx.tx.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), inArray(schema.campaigns.id, campaignIds))) : [];
  const spend = campaignIds.length ? await ctx.tx.select({ id: schema.adMetricsDaily.campaignId, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), inArray(schema.adMetricsDaily.campaignId, campaignIds))).groupBy(schema.adMetricsDaily.campaignId) : [];
  const attributed = campaignIds.length ? await ctx.tx.select({ id: schema.orderAttribution.campaignId, n: sql<number>`count(*)::int` }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.campaignId, campaignIds), inArray(schema.orders.status, [...SALE_STATUSES]))).groupBy(schema.orderAttribution.campaignId) : [];
  const cac = new Map<string, number | null>();
  for (const id of campaignIds) {
    const s = spend.find((x) => x.id === id)?.spend ?? 0;
    const n = attributed.find((x) => x.id === id)?.n ?? 0;
    cac.set(`campaign:${id}`, n > 0 ? Math.round(s / n) : null);
  }
  const keyOf = (contractId: string) => {
    const a = attrByOrder.get(firstByContract.get(contractId) ?? "");
    return a?.campaignId ? `campaign:${a.campaignId}` : `channel:${a?.channel ?? "unknown"}`;
  };
  const acquisition = subscriptionLtvByAcquisition(profit.subscribers.map((s) => ({ key: keyOf(s.contractId), contractId: s.contractId, revenueMinor: s.netRevenueMinor, profitMinor: s.profitMinor })), cac).map((r) => {
    const [kind, id] = r.key.split(":") as ["campaign" | "channel", string];
    return { ...r, kind, label: kind === "campaign" ? (campaigns.find((c) => c.id === id)?.name ?? id) : id };
  });
  return { ...profit, acquisition };
}

/* ---------- cancellation reasons ---------- */

export type CancellationDimension = "product" | "cohort" | "channel";

/** Cancellations by reason, by product / cohort / acquisition channel, and the monthly trend, over the last `months`. */
export async function cancellationAnalysis(ctx: ServiceContext, tenant: AnalyticsTenant, opts: { dimension: CancellationDimension; months?: number; asOf?: Date }) {
  const asOf = opts.asOf ?? ctx.now ?? new Date();
  const since = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - ((opts.months ?? 12) - 1), 1));
  const rows = await ctx.tx.execute<{ id: string; reason: string | null; kind: string | null; ended_at: Date | string; activated_at: Date | string; product: string | null; channel: string | null }>(sql`
    select c.id, c.cancellation_reason_code as reason, c.cancellation_kind as kind, c.ended_at, c.activated_at,
      (select l.title from subscription_contract_lines l where l.contract_id = c.id order by l.created_at limit 1) as product,
      (select a.channel from order_attribution a where a.order_id = c.origin_order_id limit 1) as channel
    from subscription_contracts c
    where c.tenant_id = ${ctx.tenantId} and c.ended_at is not null and c.ended_at >= ${since} and c.ended_at < ${new Date(asOf.getTime() + 1)}`);
  const facts = rows.rows.map((r) => {
    const ended = new Date(r.ended_at);
    const activated = new Date(r.activated_at);
    const dimension = opts.dimension === "product" ? (r.product ?? "—") : opts.dimension === "cohort" ? localDateKey(activated, tenant.timezone).slice(0, 7) : (r.channel ?? "unknown");
    return { reasonCode: r.reason ?? "other", dimension, month: localDateKey(ended, tenant.timezone).slice(0, 7), contractId: r.id, kind: r.kind };
  });
  const reasons = await cancellationReasons(ctx);
  return { ...cancellationBreakdown(facts), reasons, voluntary: facts.filter((f) => f.kind !== "involuntary").length, involuntary: facts.filter((f) => f.kind === "involuntary").length };
}
