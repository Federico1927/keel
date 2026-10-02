import { SALE_STATUSES } from "./domain";
import { splitExact } from "./ads";
import { addDaysToKey, localDateKey } from "./fulfilment";
import { effectiveTaxRateBps, type PaymentFeeSource } from "./payments";
import { PAYMENT_METHODS } from "./tenant-settings";

/**
 * Daily sales summary (issue #85): per day in the tenant's time zone and per tax rate, the money
 * view of the store's sales: gross sales, discounts, refunds, net sales, shipping and taxes (all
 * net of tax except the tax column, like the platform's own sales report), then payment fees by
 * method and the net that should reach the processor's balance. Every amount is an integer in
 * minor units of the tenant currency and every split is exact (largest remainder), so the rows of
 * a day add up to the day, the days to the period, and for each day
 *   gross − discounts − refunds = net sales,  net sales + shipping + tax = total,  total − fees = net.
 *
 * Payment-agnostic: an order is booked when it is a sale (the P/L sale scope, plus returned or
 * refunded orders whose money moved) or when money was taken (paid, partially refunded,
 * refunded), whatever the method. Its sale and fee go on the day it was placed; each refund goes
 * on the day it happened, and the part of the refunded amount no dated record explains goes on the
 * placed day.
 */

export interface SalesSummaryLineInput {
  /** Line amount as charged (quantity × price), only used as the weight of its tax rate. */
  amountMinor: number;
  /** false = zero-rated (the variant is not taxable). */
  taxable: boolean;
}
export interface SalesSummaryOrder {
  id: string;
  name: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  /** Replaced by an edit (cancel-and-recreate): lineage, never booked. */
  replaced?: boolean;
  /** Country of the tax line (shipping country, else the tenant's). */
  country: string;
  pricesIncludeTax: boolean;
  /** The tenant's rate for that country in basis points (0 = none configured). */
  rateBps: number;
  totalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  /** Tax the platform reported (0 = none: computed from `rateBps` when prices include tax, as the P/L does). */
  taxMinor: number;
  refundedMinor: number;
  lines: readonly SalesSummaryLineInput[];
  /** Dated refunds (refund records, observed refund changes, processor refunds); amounts as charged. */
  refunds: readonly { at: Date; amountMinor: number }[];
  paymentMethod: string;
  feeMinor: number;
  feeSource: PaymentFeeSource;
}

export interface SalesSummaryAmounts {
  grossSalesMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  netSalesMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
}
export interface SalesSummaryRateRow extends SalesSummaryAmounts {
  /** `<country>|<rate bps>`, e.g. `IT|2200`. */
  rateKey: string;
  country: string;
  rateBps: number;
  saleOrders: number;
  refundOrders: number;
}
export interface SalesSummaryFeeRow {
  method: string;
  feeMinor: number;
  orders: number;
  /** Orders whose fee is still the tenant's estimate (no processor fee imported yet). */
  estimatedOrders: number;
}
export interface SalesSummaryDay extends SalesSummaryAmounts {
  day: string;
  rates: SalesSummaryRateRow[];
  fees: SalesSummaryFeeRow[];
  feesMinor: number;
  netMinor: number;
  saleOrders: number;
  refundOrders: number;
  /** Every order with a sale, a refund or a fee on the day. */
  orderIds: string[];
}
/** One order's contribution to one day and rate (`sale` on the placed day, `refund` on the refund day). */
export interface SalesSummaryEntry extends SalesSummaryAmounts {
  orderId: string;
  name: string;
  day: string;
  kind: "sale" | "refund";
  rateKey: string;
}
export interface SalesSummaryFeeEntry {
  orderId: string;
  name: string;
  day: string;
  method: string;
  feeMinor: number;
  feeSource: PaymentFeeSource;
}
export interface DailySalesSummary {
  fromDay: string;
  toDay: string;
  days: SalesSummaryDay[];
  totals: SalesSummaryAmounts & { feesMinor: number; netMinor: number; saleOrders: number; refundOrders: number };
  /** Tax rates seen in the period, highest first within a country. */
  rateKeys: { rateKey: string; country: string; rateBps: number }[];
  entries: SalesSummaryEntry[];
  feeEntries: SalesSummaryFeeEntry[];
}

const BOOKED_STATUSES: readonly string[] = [...SALE_STATUSES, "returned", "refunded"];
const MONEY_TAKEN: readonly string[] = ["paid", "partially_refunded", "refunded"];

/** Whether an order is in the daily sales summary: a sale, or money was taken, and never a replaced order. */
export function bookedInSalesSummary(o: { status: string; paymentStatus: string; replaced?: boolean }): boolean {
  if (o.replaced) return false;
  return BOOKED_STATUSES.includes(o.status) || MONEY_TAKEN.includes(o.paymentStatus);
}

export const rateKeyOf = (country: string, rateBps: number) => `${country}|${rateBps}`;
export function parseRateKey(key: string): { country: string; rateBps: number } {
  const [country = "", bps = "0"] = key.split("|");
  return { country, rateBps: Number(bps) || 0 };
}

const zero = (): SalesSummaryAmounts => ({ grossSalesMinor: 0, discountsMinor: 0, refundsMinor: 0, netSalesMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 0 });
function add(target: SalesSummaryAmounts, a: SalesSummaryAmounts) {
  target.grossSalesMinor += a.grossSalesMinor;
  target.discountsMinor += a.discountsMinor;
  target.refundsMinor += a.refundsMinor;
  target.netSalesMinor += a.netSalesMinor;
  target.shippingMinor += a.shippingMinor;
  target.taxMinor += a.taxMinor;
  target.totalMinor += a.totalMinor;
}
const ratio = (amount: number, part: number, whole: number) => (whole ? Math.round((amount * part) / whole) : 0);

export interface OrderTaxBucket {
  rateKey: string;
  rateBps: number;
  /** Net of tax. */
  grossMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  /** What the customer paid for this bucket: gross − discount + shipping + tax. */
  chargedMinor: number;
}

/** The tax the summary books for an order: the platform's, else computed from the rate when prices include it (same rule as the P/L). */
export function summaryTaxMinor(o: Pick<SalesSummaryOrder, "taxMinor" | "totalMinor" | "pricesIncludeTax" | "rateBps">): number {
  const tax = Math.max(0, o.taxMinor);
  if (tax > 0 || !o.pricesIncludeTax || o.rateBps <= 0) return tax;
  const gross = Math.max(0, o.totalMinor);
  return gross - Math.round((gross * 10_000) / (10_000 + o.rateBps));
}

/**
 * The sale of one order split by tax rate. Goods are spread over the rates of their lines
 * (taxable lines at the order's rate, others at 0 %), shipping follows the order's rate, the tax is
 * spread by each part's theoretical tax. The buckets' charged amounts add up to the order total.
 */
export function orderTaxBuckets(o: SalesSummaryOrder): OrderTaxBucket[] {
  const tax = summaryTaxMinor(o);
  const excl = !o.pricesIncludeTax;
  const discount = Math.max(0, o.discountMinor);
  const shipping = Math.max(0, o.shippingMinor);
  // the order's rate: none when no tax was charged; the configured one, else the one the platform's tax implies
  const goodsAfter = o.totalMinor - shipping - (excl ? tax : 0);
  const orderRate = tax <= 0 ? 0 : o.rateBps > 0 ? o.rateBps : effectiveTaxRateBps({ taxMinor: tax, subtotalMinor: goodsAfter + discount, discountMinor: discount, pricesIncludeTax: o.pricesIncludeTax, platformTaxMinor: tax, fallbackRateBps: 0 });
  const goods = goodsAfter + discount;
  const byRate = new Map<number, number>();
  for (const l of o.lines) {
    const r = l.taxable ? orderRate : 0;
    byRate.set(r, (byRate.get(r) ?? 0) + Math.max(0, l.amountMinor));
  }
  if (![...byRate.values()].some((w) => w > 0)) byRate.clear();
  if (!byRate.size) byRate.set(orderRate, 1);
  const rates = [...byRate.keys()].sort((a, b) => b - a);
  const weights = rates.map((r) => byRate.get(r)!);
  const g = splitExact(goods, weights);
  const d = splitExact(discount, weights);
  const base = rates.map((_, i) => g[i]! - d[i]!);
  // tax spread over goods buckets and shipping by their theoretical tax
  const share = (amount: number, r: number) => (Math.max(0, amount) * r) / (excl ? 10_000 : 10_000 + r);
  const taxWeights = [...rates.map((r, i) => share(base[i]!, r)), share(shipping, orderRate)];
  const t = splitExact(tax, taxWeights.some((w) => w > 0) ? taxWeights : [1, ...taxWeights.slice(1).map(() => 0)]);
  const taxShip = t[rates.length]!;
  const out = rates.map((r, i): OrderTaxBucket => {
    const tb = t[i]!;
    const discNet = excl ? d[i]! : d[i]! - ratio(d[i]!, tb, base[i]!);
    const grossNet = excl ? g[i]! : base[i]! - tb + discNet;
    return { rateKey: rateKeyOf(o.country, r), rateBps: r, grossMinor: grossNet, discountMinor: discNet, shippingMinor: 0, taxMinor: tb, chargedMinor: grossNet - discNet + tb };
  });
  if (shipping > 0 || taxShip !== 0) {
    let b = out.find((x) => x.rateBps === orderRate);
    if (!b) {
      b = { rateKey: rateKeyOf(o.country, orderRate), rateBps: orderRate, grossMinor: 0, discountMinor: 0, shippingMinor: 0, taxMinor: 0, chargedMinor: 0 };
      out.push(b);
    }
    b.shippingMinor = excl ? shipping : shipping - taxShip;
    b.taxMinor += taxShip;
    b.chargedMinor += b.shippingMinor + taxShip;
  }
  return out;
}

/** Dated refunds capped at the refunded total (in date order), plus the unexplained remainder on the placed day. */
export function refundSchedule(o: Pick<SalesSummaryOrder, "placedAt" | "refundedMinor" | "totalMinor" | "refunds">): { at: Date; amountMinor: number }[] {
  let left = Math.min(Math.max(0, o.refundedMinor), Math.max(0, o.totalMinor));
  const out: { at: Date; amountMinor: number }[] = [];
  for (const r of [...o.refunds].filter((x) => x.amountMinor > 0).sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (left <= 0) break;
    const amount = Math.min(left, r.amountMinor);
    out.push({ at: r.at, amountMinor: amount });
    left -= amount;
  }
  if (left > 0) out.push({ at: o.placedAt, amountMinor: left });
  return out;
}

/** Inclusive list of day keys from `fromDay` to `toDay` (at most 400). */
export function dayKeysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let d = fromDay; d <= toDay && out.length < 400; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

/** Contributions of one booked order (sale, refunds, fee), every day, before filtering to a period. */
export function orderSummaryEntries(o: SalesSummaryOrder, timeZone: string): { entries: SalesSummaryEntry[]; fee: SalesSummaryFeeEntry | null } {
  if (!bookedInSalesSummary(o)) return { entries: [], fee: null };
  const buckets = orderTaxBuckets(o);
  const saleDay = localDateKey(o.placedAt, timeZone);
  const entries: SalesSummaryEntry[] = buckets.map((b) => ({ orderId: o.id, name: o.name, day: saleDay, kind: "sale", rateKey: b.rateKey, grossSalesMinor: b.grossMinor, discountsMinor: b.discountMinor, refundsMinor: 0, netSalesMinor: b.grossMinor - b.discountMinor, shippingMinor: b.shippingMinor, taxMinor: b.taxMinor, totalMinor: b.chargedMinor }));
  const weights = buckets.map((b) => Math.max(0, b.chargedMinor));
  for (const r of refundSchedule(o)) {
    const parts = splitExact(r.amountMinor, weights);
    const day = localDateKey(r.at, timeZone);
    buckets.forEach((b, i) => {
      const amount = parts[i]!;
      if (!amount) return;
      const refundTax = ratio(amount, b.taxMinor, b.chargedMinor);
      const net = amount - refundTax;
      entries.push({ orderId: o.id, name: o.name, day, kind: "refund", rateKey: b.rateKey, grossSalesMinor: 0, discountsMinor: 0, refundsMinor: net, netSalesMinor: -net, shippingMinor: 0, taxMinor: -refundTax, totalMinor: -amount });
    });
  }
  const method = (PAYMENT_METHODS as readonly string[]).includes(o.paymentMethod) ? o.paymentMethod : "other";
  const fee = o.feeMinor ? { orderId: o.id, name: o.name, day: saleDay, method, feeMinor: o.feeMinor, feeSource: o.feeSource } : null;
  return { entries, fee };
}

/**
 * The summary of a period of local days `[fromDay, toDay]`: every day of the period (empty days
 * included), each with its rows per tax rate and its fees per method, and the period totals.
 */
export function dailySalesSummary(orders: readonly SalesSummaryOrder[], opts: { timeZone: string; fromDay: string; toDay: string }): DailySalesSummary {
  const keys = dayKeysBetween(opts.fromDay, opts.toDay);
  const inRange = new Set(keys);
  const entries: SalesSummaryEntry[] = [];
  const feeEntries: SalesSummaryFeeEntry[] = [];
  for (const o of orders) {
    const r = orderSummaryEntries(o, opts.timeZone);
    for (const e of r.entries) if (inRange.has(e.day)) entries.push(e);
    if (r.fee && inRange.has(r.fee.day)) feeEntries.push(r.fee);
  }
  const days = new Map<string, SalesSummaryDay>(keys.map((day) => [day, { day, ...zero(), rates: [], fees: [], feesMinor: 0, netMinor: 0, saleOrders: 0, refundOrders: 0, orderIds: [] }]));
  const rateSeen = new Map<string, { rateKey: string; country: string; rateBps: number }>();
  const sales = new Map<string, Set<string>>();
  const refunds = new Map<string, Set<string>>();
  const touch = (m: Map<string, Set<string>>, k: string, id: string) => {
    const s = m.get(k) ?? new Set<string>();
    s.add(id);
    m.set(k, s);
  };
  const ids = new Map<string, Set<string>>();
  for (const e of entries) {
    const day = days.get(e.day)!;
    let row = day.rates.find((x) => x.rateKey === e.rateKey);
    if (!row) {
      const { country, rateBps } = parseRateKey(e.rateKey);
      row = { rateKey: e.rateKey, country, rateBps, ...zero(), saleOrders: 0, refundOrders: 0 };
      day.rates.push(row);
      rateSeen.set(e.rateKey, { rateKey: e.rateKey, country, rateBps });
    }
    add(row, e);
    add(day, e);
    touch(e.kind === "sale" ? sales : refunds, `${e.day}#${e.rateKey}`, e.orderId);
    touch(e.kind === "sale" ? sales : refunds, e.day, e.orderId);
    touch(ids, e.day, e.orderId);
  }
  for (const f of feeEntries) {
    const day = days.get(f.day)!;
    let row = day.fees.find((x) => x.method === f.method);
    if (!row) {
      row = { method: f.method, feeMinor: 0, orders: 0, estimatedOrders: 0 };
      day.fees.push(row);
    }
    row.feeMinor += f.feeMinor;
    row.orders++;
    if (f.feeSource === "estimate") row.estimatedOrders++;
    day.feesMinor += f.feeMinor;
    touch(ids, f.day, f.orderId);
  }
  const sortRates = (a: { country: string; rateBps: number }, b: { country: string; rateBps: number }) => a.country.localeCompare(b.country) || b.rateBps - a.rateBps;
  const totals = { ...zero(), feesMinor: 0, netMinor: 0, saleOrders: 0, refundOrders: 0 };
  for (const day of days.values()) {
    for (const row of day.rates) {
      row.saleOrders = sales.get(`${day.day}#${row.rateKey}`)?.size ?? 0;
      row.refundOrders = refunds.get(`${day.day}#${row.rateKey}`)?.size ?? 0;
    }
    day.rates.sort(sortRates);
    day.fees.sort((a, b) => PAYMENT_METHODS.indexOf(a.method as (typeof PAYMENT_METHODS)[number]) - PAYMENT_METHODS.indexOf(b.method as (typeof PAYMENT_METHODS)[number]));
    day.netMinor = day.totalMinor - day.feesMinor;
    day.saleOrders = sales.get(day.day)?.size ?? 0;
    day.refundOrders = refunds.get(day.day)?.size ?? 0;
    day.orderIds = [...(ids.get(day.day) ?? [])].sort();
    add(totals, day);
    totals.feesMinor += day.feesMinor;
    totals.netMinor += day.netMinor;
    totals.saleOrders += day.saleOrders;
    totals.refundOrders += day.refundOrders;
  }
  return { fromDay: opts.fromDay, toDay: opts.toDay, days: [...days.values()], totals, rateKeys: [...rateSeen.values()].sort(sortRates), entries, feeEntries };
}

/** Whether the identities of a summary day hold (used by tests and by the accounting push as a guard). */
export function summaryDayAddsUp(d: SalesSummaryDay): boolean {
  const sum = zero();
  for (const r of d.rates) {
    if (r.grossSalesMinor - r.discountsMinor - r.refundsMinor !== r.netSalesMinor || r.netSalesMinor + r.shippingMinor + r.taxMinor !== r.totalMinor) return false;
    add(sum, r);
  }
  return sum.totalMinor === d.totalMinor && sum.grossSalesMinor === d.grossSalesMinor && sum.taxMinor === d.taxMinor && sum.refundsMinor === d.refundsMinor && d.netMinor === d.totalMinor - d.fees.reduce((s, f) => s + f.feeMinor, 0);
}

/**
 * The local days a summary page covers: explicit `from`/`to` dates (YYYY-MM-DD, local), or a
 * preset ending today (`7d`, `30d`, `90d`, month to date, year to date). At most 366 days.
 */
export function summaryDayRange(sp: { preset?: string; from?: string; to?: string }, timeZone: string, now: Date, defaultPreset = "30d"): { fromDay: string; toDay: string; preset: string | undefined } {
  const today = localDateKey(now, timeZone);
  const isDay = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  if (!sp.preset && isDay(sp.from)) {
    let to = isDay(sp.to) ? sp.to : today;
    if (to < sp.from) to = sp.from;
    const limit = addDaysToKey(sp.from, 365);
    return { fromDay: sp.from, toDay: to > limit ? limit : to, preset: undefined };
  }
  const preset = ["7d", "30d", "90d", "mtd", "ytd"].includes(sp.preset ?? "") ? sp.preset! : defaultPreset;
  const fromDay = preset === "mtd" ? `${today.slice(0, 7)}-01` : preset === "ytd" ? `${today.slice(0, 4)}-01-01` : addDaysToKey(today, -(Number(preset.replace("d", "")) - 1));
  return { fromDay, toDay: today, preset };
}
