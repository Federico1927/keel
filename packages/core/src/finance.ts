import { SALE_STATUSES, type OrderStatus } from "./domain";
import { pct, safeDiv } from "./money";
import type { PaymentMethod } from "./tenant-settings";

/** Whether an order counts as a sale for revenue, profit and attribution (CLAUDE.md §7.5). */
export function countsAsSale(status: OrderStatus | string): boolean {
  return (SALE_STATUSES as readonly string[]).includes(status);
}

export interface EconomicsLine {
  quantity: number;
  unitPriceMinor: number;
  unitCostMinor: number | null;
  isAncillary?: boolean;
}
export interface EconomicsInput {
  status: OrderStatus | string;
  totalMinor: number;
  taxMinor: number;
  refundedMinor: number;
  /** Fraction of the order returned (0..1), from the returns module. */
  returnedFraction?: number;
  /** Used only when taxMinor is 0 and prices include tax. */
  taxRateBps: number;
  pricesIncludeTax: boolean;
  lines: EconomicsLine[];
  paymentMethod: PaymentMethod | string;
  paymentFeeBps: number;
  paymentFeeFixedMinor: number;
  shippingCostMinor: number;
}
export interface OrderEconomics {
  inScope: boolean;
  grossRevenueMinor: number;
  taxMinor: number;
  netRevenueMinor: number;
  cogsMinor: number;
  cogsComplete: boolean;
  shippingCostMinor: number;
  paymentFeeMinor: number;
  refundedMinor: number;
  marginMinor: number;
  marginRate: number | null;
}

/**
 * Economics of one order, computed once and reused by dashboard, P/L, campaigns and
 * discounts. Net revenue is net of tax and refunds; COGS from the cost snapshot on the
 * lines (last purchase cost at import time); payment fee by normalized method.
 */
export function orderEconomics(i: EconomicsInput): OrderEconomics {
  const inScope = countsAsSale(i.status);
  const gross = Math.max(0, i.totalMinor);
  let tax = Math.max(0, i.taxMinor);
  if (tax === 0 && i.pricesIncludeTax && i.taxRateBps > 0) tax = gross - Math.round((gross * 10_000) / (10_000 + i.taxRateBps));
  const refunded = Math.min(gross, Math.max(0, i.refundedMinor));
  const taxShare = gross > 0 ? tax / gross : 0;
  const netRevenue = Math.round((gross - refunded) * (1 - taxShare));
  let cogs = 0;
  let cogsComplete = true;
  const keep = 1 - Math.min(1, Math.max(0, i.returnedFraction ?? 0));
  for (const l of i.lines) {
    if (l.isAncillary) continue;
    if (l.unitCostMinor === null || l.unitCostMinor === undefined) {
      cogsComplete = false;
      continue;
    }
    cogs += l.quantity * l.unitCostMinor;
  }
  cogs = Math.round(cogs * keep);
  const paymentFee = inScope ? pct(gross, i.paymentFeeBps) + i.paymentFeeFixedMinor : 0;
  const shippingCost = inScope ? i.shippingCostMinor : 0;
  const margin = inScope ? netRevenue - cogs - shippingCost - paymentFee : 0;
  return {
    inScope,
    grossRevenueMinor: inScope ? gross : 0,
    taxMinor: inScope ? tax : 0,
    netRevenueMinor: inScope ? netRevenue : 0,
    cogsMinor: inScope ? cogs : 0,
    cogsComplete,
    shippingCostMinor: shippingCost,
    paymentFeeMinor: paymentFee,
    refundedMinor: inScope ? refunded : 0,
    marginMinor: margin,
    marginRate: inScope ? safeDiv(margin, netRevenue) : null,
  };
}

export interface PnlTotals {
  orders: number;
  grossRevenueMinor: number;
  taxMinor: number;
  netRevenueMinor: number;
  refundedMinor: number;
  cogsMinor: number;
  cogsIncompleteOrders: number;
  grossMarginMinor: number;
  shippingCostMinor: number;
  paymentFeeMinor: number;
  /** Return labels and handling of the returns received in the period, net of deductions charged to customers. */
  returnCostsMinor: number;
  contributionMinor: number;
  adSpendMinor: number;
  fixedCostsMinor: number;
  operatingProfitMinor: number;
  aovMinor: number | null;
  grossMarginRate: number | null;
  contributionRate: number | null;
}

export function sumEconomics(rows: readonly OrderEconomics[], adSpendMinor: number, fixedCostsMinor: number, returnCostsMinor = 0): PnlTotals {
  const t: PnlTotals = { orders: 0, grossRevenueMinor: 0, taxMinor: 0, netRevenueMinor: 0, refundedMinor: 0, cogsMinor: 0, cogsIncompleteOrders: 0, grossMarginMinor: 0, shippingCostMinor: 0, paymentFeeMinor: 0, returnCostsMinor, contributionMinor: 0, adSpendMinor, fixedCostsMinor, operatingProfitMinor: 0, aovMinor: null, grossMarginRate: null, contributionRate: null };
  for (const r of rows) {
    if (!r.inScope) continue;
    t.orders++;
    t.grossRevenueMinor += r.grossRevenueMinor;
    t.taxMinor += r.taxMinor;
    t.netRevenueMinor += r.netRevenueMinor;
    t.refundedMinor += r.refundedMinor;
    t.cogsMinor += r.cogsMinor;
    if (!r.cogsComplete) t.cogsIncompleteOrders++;
    t.shippingCostMinor += r.shippingCostMinor;
    t.paymentFeeMinor += r.paymentFeeMinor;
  }
  t.grossMarginMinor = t.netRevenueMinor - t.cogsMinor;
  t.contributionMinor = t.grossMarginMinor - t.shippingCostMinor - t.paymentFeeMinor - t.returnCostsMinor;
  t.operatingProfitMinor = t.contributionMinor - adSpendMinor - fixedCostsMinor;
  t.aovMinor = t.orders ? Math.round(t.grossRevenueMinor / t.orders) : null;
  t.grossMarginRate = safeDiv(t.grossMarginMinor, t.netRevenueMinor);
  t.contributionRate = safeDiv(t.contributionMinor, t.netRevenueMinor);
  return t;
}

/** Share of a monthly fixed cost that falls inside [from, to). */
export function prorateMonthlyCost(amountMinor: number, validFrom: string, validTo: string | null, from: Date, to: Date): number {
  const start = new Date(Math.max(new Date(validFrom + "T00:00:00Z").getTime(), from.getTime()));
  const end = new Date(Math.min(validTo ? new Date(validTo + "T00:00:00Z").getTime() + 864e5 : Infinity, to.getTime()));
  if (end <= start) return 0;
  const days = (end.getTime() - start.getTime()) / 864e5;
  return Math.round((amountMinor * days) / 30.4375);
}

/** Relative change between two values; null when the previous value is zero. */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / previous;
}

export interface Period {
  from: Date;
  to: Date;
}
/** Previous period of the same length, ending where the current one starts. */
export function previousPeriod(p: Period): Period {
  const len = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - len), to: new Date(p.from.getTime()) };
}

/** "Running" windows: today until now, yesterday until the same time, a week ago until the same time. */
export function runningWindows(now: Date, timeZone: string): { today: Period; yesterday: Period; lastWeek: Period } {
  const local = new Date(now.toLocaleString("en-US", { timeZone }));
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = local.getTime() - utc.getTime();
  const midnightLocal = new Date(local);
  midnightLocal.setHours(0, 0, 0, 0);
  const midnight = new Date(midnightLocal.getTime() - offsetMs);
  const today = { from: midnight, to: now };
  return { today, yesterday: { from: new Date(midnight.getTime() - 864e5), to: new Date(now.getTime() - 864e5) }, lastWeek: { from: new Date(midnight.getTime() - 7 * 864e5), to: new Date(now.getTime() - 7 * 864e5) } };
}

/**
 * Cost of handling returns in a period: a label and handling for every return whose goods came
 * back (returnless ones cost neither), minus the return shipping charged to customers at fault.
 */
export function returnCostsOfPeriod(returns: readonly { goodsBack: boolean; returnless: boolean; deductionMinor: number }[], labelMinor: number, handlingMinor: number): { labelsMinor: number; handlingMinor: number; recoveredMinor: number; totalMinor: number } {
  const handled = returns.filter((r) => r.goodsBack && !r.returnless);
  const labels = handled.length * Math.max(0, labelMinor);
  const handling = handled.length * Math.max(0, handlingMinor);
  const recovered = handled.reduce((s, r) => s + Math.max(0, r.deductionMinor), 0);
  return { labelsMinor: labels, handlingMinor: handling, recoveredMinor: recovered, totalMinor: Math.max(0, labels + handling - recovered) };
}

/** Return rate per option value ("Size: M"), from units sold and returned with their variant options. */
export function optionReturnRates(sold: readonly { options: Record<string, string>; quantity: number }[], returned: readonly { options: Record<string, string>; quantity: number }[], minSold = 1): { option: string; value: string; sold: number; returned: number; rate: number }[] {
  const acc = new Map<string, { option: string; value: string; sold: number; returned: number }>();
  const add = (rows: readonly { options: Record<string, string>; quantity: number }[], field: "sold" | "returned") => {
    for (const r of rows) {
      for (const [option, value] of Object.entries(r.options ?? {})) {
        if (!value) continue;
        const k = `${option}\u0000${value}`;
        const cur = acc.get(k) ?? { option, value, sold: 0, returned: 0 };
        cur[field] += r.quantity;
        acc.set(k, cur);
      }
    }
  };
  add(sold, "sold");
  add(returned, "returned");
  return [...acc.values()].filter((x) => x.sold >= minSold).map((x) => ({ ...x, rate: x.sold ? x.returned / x.sold : 0 })).sort((a, b) => a.option.localeCompare(b.option) || b.rate - a.rate);
}
