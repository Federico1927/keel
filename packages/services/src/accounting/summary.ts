import { and, eq, gte, inArray, lt, schema, sql } from "@hullwise/db";
import { addDaysToKey, dailySalesSummary, pct, resolvePaymentFee, zonedDayStart, type DailySalesSummary, type SalesSummaryOrder, type TenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "../analytics";

/**
 * Daily sales summary (issue #85, core: every tenant). Loads the facts of the orders whose sale or
 * refund falls in a range of local days and hands them to the pure `dailySalesSummary`:
 * - the orders placed in the range, and those with a refund dated in it;
 * - line amounts with the variant's taxable flag (rate weights);
 * - dated refunds: every order event that raised `refundedMinor` (Hullwise refunds, platform
 *   updates, returns), else the processor's refund transactions;
 * - the payment fee: the processor's actual fee once a charge was imported, else the tenant's rate.
 */
export interface DayRange {
  fromDay: string;
  toDay: string;
}

const NONE = "00000000-0000-0000-0000-000000000000";
const ids = (xs: readonly string[]) => (xs.length ? [...xs] : [NONE]);

export async function salesSummaryOrders(ctx: ServiceContext, tenant: AnalyticsTenant, range: DayRange, opts: { orderIds?: string[] } = {}): Promise<SalesSummaryOrder[]> {
  const from = zonedDayStart(range.fromDay, tenant.timezone);
  const to = zonedDayStart(addDaysToKey(range.toDay, 1), tenant.timezone);
  const t = ctx.tenantId;
  let orderIds: string[];
  if (opts.orderIds) orderIds = opts.orderIds;
  else {
    const placed = await ctx.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, t), gte(schema.orders.placedAt, from), lt(schema.orders.placedAt, to)));
    const refundedByEvent = await ctx.tx.selectDistinct({ id: schema.orderEvents.orderId }).from(schema.orderEvents).where(and(eq(schema.orderEvents.tenantId, t), gte(schema.orderEvents.createdAt, from), lt(schema.orderEvents.createdAt, to), sql`${schema.orderEvents.diff} ? 'refundedMinor'`));
    const refundedByProcessor = await ctx.tx.selectDistinct({ id: schema.balanceTransactions.orderId }).from(schema.balanceTransactions).where(and(eq(schema.balanceTransactions.tenantId, t), eq(schema.balanceTransactions.type, "refund"), gte(schema.balanceTransactions.occurredAt, from), lt(schema.balanceTransactions.occurredAt, to)));
    orderIds = [...new Set([...placed.map((r) => r.id), ...refundedByEvent.map((r) => r.id), ...refundedByProcessor.map((r) => r.id).filter((x): x is string => !!x)])];
  }
  if (!orderIds.length) return [];
  const orders = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, t), inArray(schema.orders.id, ids(orderIds))));
  const lines = await ctx.tx
    .select({ orderId: schema.orderLines.orderId, quantity: schema.orderLines.quantity, unitPriceMinor: schema.orderLines.unitPriceMinor, totalMinor: schema.orderLines.totalMinor, taxable: schema.productVariants.taxable })
    .from(schema.orderLines)
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
    .where(and(eq(schema.orderLines.tenantId, t), inArray(schema.orderLines.orderId, ids(orderIds))));
  const events = await ctx.tx
    .select({ orderId: schema.orderEvents.orderId, at: schema.orderEvents.createdAt, from: sql<string | null>`${schema.orderEvents.diff} -> 'refundedMinor' ->> 'from'`, to: sql<string | null>`${schema.orderEvents.diff} -> 'refundedMinor' ->> 'to'` })
    .from(schema.orderEvents)
    .where(and(eq(schema.orderEvents.tenantId, t), inArray(schema.orderEvents.orderId, ids(orderIds)), sql`${schema.orderEvents.diff} ? 'refundedMinor'`));
  const txns = await ctx.tx
    .select({ orderId: schema.balanceTransactions.orderId, type: schema.balanceTransactions.type, amountMinor: schema.balanceTransactions.amountMinor, feeMinor: schema.balanceTransactions.feeMinor, at: schema.balanceTransactions.occurredAt })
    .from(schema.balanceTransactions)
    .where(and(eq(schema.balanceTransactions.tenantId, t), inArray(schema.balanceTransactions.orderId, ids(orderIds))));
  const rates = await ctx.tx.select({ country: schema.tenantTaxRates.country, rateBps: schema.tenantTaxRates.rateBps, pricesIncludeTax: schema.tenantTaxRates.pricesIncludeTax }).from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, t));
  const rateFor = (country: string | null) => rates.find((r) => r.country === country) ?? rates.find((r) => r.country === tenant.country) ?? { country: tenant.country, rateBps: 0, pricesIncludeTax: true };
  const group = <R extends { orderId: string | null }>(rows: R[]) => {
    const m = new Map<string, R[]>();
    for (const r of rows) if (r.orderId) m.set(r.orderId, [...(m.get(r.orderId) ?? []), r]);
    return m;
  };
  const linesBy = group(lines);
  const eventsBy = group(events);
  const txnsBy = group(txns);
  return orders.map((o): SalesSummaryOrder => {
    const rate = rateFor(o.shippingCountry);
    const ev = (eventsBy.get(o.id) ?? []).map((e) => ({ at: e.at, amountMinor: Number(e.to ?? 0) - Number(e.from ?? 0) })).filter((e) => Number.isFinite(e.amountMinor) && e.amountMinor > 0);
    const own = txnsBy.get(o.id) ?? [];
    const refunds = ev.length ? ev : own.filter((x) => x.type === "refund").map((x) => ({ at: x.at, amountMinor: Math.abs(x.amountMinor) }));
    const method = o.paymentMethod as keyof TenantSettings["paymentFeeBps"];
    const charged = own.some((x) => x.type === "charge");
    const fee = resolvePaymentFee(pct(Math.max(0, o.totalMinor), tenant.settings.paymentFeeBps[method] ?? 0) + (tenant.settings.paymentFeeFixedMinor[method] ?? 0), charged ? own.reduce((s, x) => s + x.feeMinor, 0) : null);
    return {
      id: o.id,
      name: o.name,
      placedAt: o.placedAt,
      status: o.status,
      paymentStatus: o.paymentStatus,
      replaced: o.replacedByOrderId !== null,
      country: o.shippingCountry ?? tenant.country,
      pricesIncludeTax: rate.pricesIncludeTax,
      rateBps: rate.rateBps,
      totalMinor: o.totalMinor,
      discountMinor: o.discountMinor,
      shippingMinor: o.shippingMinor,
      taxMinor: o.taxMinor,
      refundedMinor: o.refundedMinor,
      lines: (linesBy.get(o.id) ?? []).map((l) => ({ amountMinor: l.quantity * l.unitPriceMinor || l.totalMinor, taxable: l.taxable !== false })),
      refunds,
      paymentMethod: o.paymentMethod,
      feeMinor: fee.feeMinor,
      feeSource: fee.source,
    };
  });
}

/** The daily sales summary of a range of local days in the tenant's time zone and currency. */
export async function dailySalesSummaryFor(ctx: ServiceContext, tenant: AnalyticsTenant, range: DayRange): Promise<DailySalesSummary> {
  return dailySalesSummary(await salesSummaryOrders(ctx, tenant, range), { timeZone: tenant.timezone, ...range });
}

export interface SalesDayOrder {
  orderId: string;
  name: string;
  placedAt: Date;
  status: string;
  paymentMethod: string;
  kinds: ("sale" | "refund" | "fee")[];
  rateKeys: string[];
  grossSalesMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  feeMinor: number;
}

/**
 * The orders behind one day of the summary, each with its contribution (what the day's numbers link
 * to), optionally narrowed to a tax rate, a payment method (fees) or a kind (sales, refunds).
 */
export async function salesDayOrders(ctx: ServiceContext, tenant: AnalyticsTenant, day: string, filter: { rateKey?: string; method?: string; kind?: "sale" | "refund" | "fee" } = {}): Promise<{ summary: DailySalesSummary; orders: SalesDayOrder[] }> {
  const orders = await salesSummaryOrders(ctx, tenant, { fromDay: day, toDay: day });
  const summary = dailySalesSummary(orders, { timeZone: tenant.timezone, fromDay: day, toDay: day });
  const byId = new Map(orders.map((o) => [o.id, o]));
  const out = new Map<string, SalesDayOrder>();
  const row = (id: string) => {
    let r = out.get(id);
    if (!r) {
      const o = byId.get(id)!;
      r = { orderId: id, name: o.name, placedAt: o.placedAt, status: o.status, paymentMethod: o.paymentMethod, kinds: [], rateKeys: [], grossSalesMinor: 0, discountsMinor: 0, refundsMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 0, feeMinor: 0 };
      out.set(id, r);
    }
    return r;
  };
  for (const e of summary.entries) {
    if (filter.rateKey && e.rateKey !== filter.rateKey) continue;
    if (filter.method || (filter.kind && filter.kind !== e.kind)) continue;
    const r = row(e.orderId);
    if (!r.kinds.includes(e.kind)) r.kinds.push(e.kind);
    if (!r.rateKeys.includes(e.rateKey)) r.rateKeys.push(e.rateKey);
    r.grossSalesMinor += e.grossSalesMinor;
    r.discountsMinor += e.discountsMinor;
    r.refundsMinor += e.refundsMinor;
    r.shippingMinor += e.shippingMinor;
    r.taxMinor += e.taxMinor;
    r.totalMinor += e.totalMinor;
  }
  if (!filter.rateKey && (!filter.kind || filter.kind === "fee")) {
    for (const f of summary.feeEntries) {
      if (filter.method && f.method !== filter.method) continue;
      const r = row(f.orderId);
      if (!r.kinds.includes("fee")) r.kinds.push("fee");
      r.feeMinor += f.feeMinor;
    }
  }
  return { summary, orders: [...out.values()].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime() || a.name.localeCompare(b.name)) };
}
