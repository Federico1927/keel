import { localDateKey } from "./fulfilment";
import { DEFAULT_CHURN_THRESHOLDS, churnRiskOf, type ChurnRisk, type ChurnThresholds } from "./predictions";
import type { SegmentFieldDef, SegmentGroup } from "./segments";

/**
 * Merchant subscriptions (`addon.subscriptions`, issue #67): analytics and operations on the
 * subscription products a store sells through its subscription app (Shopify Subscriptions,
 * Recharge, Loop). Hullwise is not the billing engine: these are pure calculations over contracts,
 * billing attempts and orders the adapters import. Money in minor units, dates as `Date`.
 */

const DAY = 864e5;

export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled", "expired", "failed"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** A live contract still has a customer relationship (MRR counts only while active). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["active", "paused"];
export const SUBSCRIPTION_INTERVALS = ["day", "week", "month", "year"] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];
export const SUBSCRIPTION_EVENT_TYPES = ["created", "paused", "resumed", "skipped", "swapped", "frequency_changed", "rescheduled", "cancelled", "reactivated", "price_changed", "payment_failed", "payment_recovered", "payment_link_sent", "note", "assigned"] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];
export const SUBSCRIPTION_EVENT_AUTHORS = ["customer", "staff", "system", "provider"] as const;
export type SubscriptionEventAuthor = (typeof SUBSCRIPTION_EVENT_AUTHORS)[number];
/** Normalized reasons a renewal charge failed; adapters map provider codes onto these. */
export const SUBSCRIPTION_PAYMENT_ERRORS = ["card_expired", "insufficient_funds", "card_declined", "authentication_required", "processing_error", "other"] as const;
export type SubscriptionPaymentError = (typeof SUBSCRIPTION_PAYMENT_ERRORS)[number];
export type CancellationKind = "voluntary" | "involuntary";

/* ---------- capabilities and customer-care actions ---------- */

/** What the connected subscription app lets Hullwise do; actions without the capability are never offered. */
export interface SubscriptionCapabilities {
  canPause: boolean;
  canResume: boolean;
  canSkip: boolean;
  canSwap: boolean;
  canChangeFrequency: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  canSendPaymentLink: boolean;
}
export const NO_SUBSCRIPTION_CAPABILITIES: SubscriptionCapabilities = { canPause: false, canResume: false, canSkip: false, canSwap: false, canChangeFrequency: false, canReschedule: false, canCancel: false, canSendPaymentLink: false };
export const SUBSCRIPTION_ACTIONS = ["pause", "resume", "skip", "swap", "frequency", "reschedule", "cancel", "payment_link"] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];
const ACTION_CAPABILITY: Record<SubscriptionAction, keyof SubscriptionCapabilities> = { pause: "canPause", resume: "canResume", skip: "canSkip", swap: "canSwap", frequency: "canChangeFrequency", reschedule: "canReschedule", cancel: "canCancel", payment_link: "canSendPaymentLink" };

/** Whether an action is possible on a contract in its current status with the provider's capabilities. */
export function subscriptionActionAllowed(action: SubscriptionAction, status: string, caps: SubscriptionCapabilities): boolean {
  if (!caps[ACTION_CAPABILITY[action]]) return false;
  switch (action) {
    case "resume": return status === "paused";
    case "pause": return status === "active";
    case "payment_link": return status === "active" || status === "paused" || status === "failed";
    default: return status === "active" || status === "paused";
  }
}

/* ---------- money normalization ---------- */

/** Monthly equivalent of a recurring charge (MRR contribution), rounded to minor units. */
export function subscriptionMonthlyAmount(priceMinor: number, unit: SubscriptionInterval | string, count: number): number {
  const n = Math.max(1, Math.round(count || 1));
  const perMonth = unit === "day" ? 365 / 12 : unit === "week" ? 52 / 12 : unit === "year" ? 1 / 12 : 1;
  return Math.round((priceMinor * perMonth) / n);
}

/** Next billing date after `from` for an interval (calendar months and years, fixed days and weeks; UTC). */
export function addSubscriptionInterval(from: Date, unit: SubscriptionInterval | string, count: number): Date {
  const n = Math.max(1, Math.round(count || 1));
  if (unit === "day") return new Date(from.getTime() + n * DAY);
  if (unit === "week") return new Date(from.getTime() + n * 7 * DAY);
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (unit === "year" ? 12 * n : n));
  return d;
}

/** Billing dates from `next` (an overdue date counts once, at `asOf`) until `until` (exclusive). */
export function projectRenewalDates(c: { nextBillingAt: Date | null; intervalUnit: string; intervalCount: number }, asOf: Date, until: Date, max = 60): Date[] {
  if (!c.nextBillingAt) return [];
  const out: Date[] = [];
  let d = c.nextBillingAt;
  if (d.getTime() < asOf.getTime()) {
    out.push(asOf);
    d = addSubscriptionInterval(d, c.intervalUnit, c.intervalCount);
    while (d.getTime() <= asOf.getTime()) d = addSubscriptionInterval(d, c.intervalUnit, c.intervalCount);
  }
  while (d.getTime() < until.getTime() && out.length < max) {
    out.push(d);
    d = addSubscriptionInterval(d, c.intervalUnit, c.intervalCount);
  }
  return out.filter((x) => x.getTime() < until.getTime());
}

/* ---------- timelines ---------- */

/**
 * One contract over time, rebuilt by the services from the contract row and its events:
 * live from `activatedAt` until `endedAt`, MRR as a step function, paused intervals at zero MRR.
 */
export interface SubscriptionTimeline {
  contractId: string;
  customerId: string;
  activatedAt: Date;
  endedAt: Date | null;
  endKind: CancellationKind | null;
  /** MRR from each date on, sorted; the first entry starts at activation. */
  mrr: { from: Date; mrrMinor: number }[];
  pauses: { from: Date; to: Date | null }[];
}

export function timelineLiveAt(tl: SubscriptionTimeline, t: Date): boolean {
  return tl.activatedAt.getTime() <= t.getTime() && (tl.endedAt === null || t.getTime() < tl.endedAt.getTime());
}
export function timelinePausedAt(tl: SubscriptionTimeline, t: Date): boolean {
  return timelineLiveAt(tl, t) && tl.pauses.some((p) => p.from.getTime() <= t.getTime() && (p.to === null || t.getTime() < p.to.getTime()));
}
export function timelineMrrAt(tl: SubscriptionTimeline, t: Date): number {
  if (!timelineLiveAt(tl, t) || timelinePausedAt(tl, t)) return 0;
  let v = tl.mrr[0]?.mrrMinor ?? 0;
  for (const s of tl.mrr) if (s.from.getTime() <= t.getTime()) v = s.mrrMinor;
  return v;
}

export interface SubscriptionPeriod {
  from: Date;
  to: Date;
}

export interface SubscriberCounts {
  /** At the end of the period (the instant before `to`). */
  active: number;
  paused: number;
  /** Live (active or paused) at the start of the period: the churn denominator. */
  liveAtStart: number;
  new: number;
  cancelled: number;
  voluntary: number;
  involuntary: number;
  churnRate: number | null;
  voluntaryRate: number | null;
  involuntaryRate: number | null;
  /** Contract ids behind each number (drill-down). */
  ids: { active: string[]; paused: string[]; new: string[]; cancelled: string[]; voluntary: string[]; involuntary: string[] };
}

/** Subscriber counts over a period, churn split voluntary (the customer cancelled) vs involuntary (payment failures). */
export function subscriberCounts(timelines: readonly SubscriptionTimeline[], p: SubscriptionPeriod): SubscriberCounts {
  const end = new Date(p.to.getTime() - 1);
  const ids: SubscriberCounts["ids"] = { active: [], paused: [], new: [], cancelled: [], voluntary: [], involuntary: [] };
  let liveAtStart = 0;
  for (const tl of timelines) {
    if (timelineLiveAt(tl, p.from) && tl.activatedAt.getTime() < p.from.getTime()) liveAtStart++;
    if (timelineLiveAt(tl, end)) (timelinePausedAt(tl, end) ? ids.paused : ids.active).push(tl.contractId);
    if (tl.activatedAt.getTime() >= p.from.getTime() && tl.activatedAt.getTime() < p.to.getTime()) ids.new.push(tl.contractId);
    if (tl.endedAt && tl.endedAt.getTime() >= p.from.getTime() && tl.endedAt.getTime() < p.to.getTime()) {
      ids.cancelled.push(tl.contractId);
      (tl.endKind === "involuntary" ? ids.involuntary : ids.voluntary).push(tl.contractId);
    }
  }
  const rate = (n: number) => (liveAtStart > 0 ? n / liveAtStart : null);
  return { active: ids.active.length, paused: ids.paused.length, liveAtStart, new: ids.new.length, cancelled: ids.cancelled.length, voluntary: ids.voluntary.length, involuntary: ids.involuntary.length, churnRate: rate(ids.cancelled.length), voluntaryRate: rate(ids.voluntary.length), involuntaryRate: rate(ids.involuntary.length), ids };
}

export interface MrrMovement {
  from: Date;
  to: Date;
  startMrrMinor: number;
  newMinor: number;
  expansionMinor: number;
  contractionMinor: number;
  churnedMinor: number;
  reactivatedMinor: number;
  endMrrMinor: number;
  /** Customer ids per bucket (links to the subscribers behind each number). */
  customers: { new: string[]; expansion: string[]; contraction: string[]; churned: string[]; reactivated: string[] };
}

/**
 * MRR movement per customer between the start and the end of a period. A customer is live while one
 * of their contracts is active or paused (a paused contract counts zero MRR, so a pause is
 * contraction and a resume expansion, not churn). Not live → live: new, or reactivated when they had
 * a contract before; live → not live: churned. By construction
 * start + new + expansion + reactivated − contraction − churned = end.
 */
export function subscriptionMrrMovement(timelines: readonly SubscriptionTimeline[], p: SubscriptionPeriod): MrrMovement {
  const end = new Date(p.to.getTime() - 1);
  const byCustomer = new Map<string, SubscriptionTimeline[]>();
  for (const tl of timelines) byCustomer.set(tl.customerId, [...(byCustomer.get(tl.customerId) ?? []), tl]);
  const m: MrrMovement = { from: p.from, to: p.to, startMrrMinor: 0, newMinor: 0, expansionMinor: 0, contractionMinor: 0, churnedMinor: 0, reactivatedMinor: 0, endMrrMinor: 0, customers: { new: [], expansion: [], contraction: [], churned: [], reactivated: [] } };
  // the start is the instant before the period: something activated exactly at `from` is new, not starting MRR
  const start = new Date(p.from.getTime() - 1);
  for (const [customerId, tls] of byCustomer) {
    const liveS = tls.some((t) => timelineLiveAt(t, start));
    const liveE = tls.some((t) => timelineLiveAt(t, end));
    const s = tls.reduce((a, t) => a + timelineMrrAt(t, start), 0);
    const e = tls.reduce((a, t) => a + timelineMrrAt(t, end), 0);
    m.startMrrMinor += s;
    m.endMrrMinor += e;
    if (!liveS && liveE) {
      const before = tls.some((t) => t.activatedAt.getTime() < p.from.getTime());
      if (before) { m.reactivatedMinor += e; m.customers.reactivated.push(customerId); }
      else { m.newMinor += e; m.customers.new.push(customerId); }
    } else if (liveS && !liveE) {
      m.churnedMinor += s;
      m.customers.churned.push(customerId);
    } else if (liveS && liveE && e !== s) {
      if (e > s) { m.expansionMinor += e - s; m.customers.expansion.push(customerId); }
      else { m.contractionMinor += s - e; m.customers.contraction.push(customerId); }
    }
  }
  return m;
}

/** UTC calendar months ending with the one containing `asOf` (oldest first). */
export function subscriptionMonths(asOf: Date, count: number): SubscriptionPeriod[] {
  const out: SubscriptionPeriod[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    out.push({ from, to: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) });
  }
  return out;
}

/* ---------- survival cohorts ---------- */

export interface SurvivalCohort {
  /** Activation month in the store time zone, `YYYY-MM`. */
  cohort: string;
  size: number;
  /** Share still live k months after each contract's activation; null when no contract is that old yet. */
  retention: (number | null)[];
  /** Contracts that reached month k (the denominator of each cell). */
  eligible: number[];
}

/** Survival by activation month: cell k = contracts still live k calendar months after activation, among those old enough. */
export function subscriptionSurvivalCohorts(timelines: readonly SubscriptionTimeline[], asOf: Date, opts: { months: number; timeZone: string }): SurvivalCohort[] {
  const groups = new Map<string, SubscriptionTimeline[]>();
  for (const tl of timelines) {
    if (tl.activatedAt.getTime() > asOf.getTime()) continue;
    const k = localDateKey(tl.activatedAt, opts.timeZone).slice(0, 7);
    groups.set(k, [...(groups.get(k) ?? []), tl]);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([cohort, tls]) => {
    const retention: (number | null)[] = [];
    const eligible: number[] = [];
    for (let k = 0; k <= opts.months; k++) {
      let n = 0;
      let alive = 0;
      for (const tl of tls) {
        const at = addSubscriptionInterval(tl.activatedAt, "month", k || 1);
        const point = k === 0 ? tl.activatedAt : at;
        if (point.getTime() > asOf.getTime()) continue;
        n++;
        if (tl.endedAt === null || tl.endedAt.getTime() > point.getTime()) alive++;
      }
      eligible.push(n);
      retention.push(n > 0 ? alive / n : null);
    }
    return { cohort, size: tls.length, retention, eligible };
  });
}

/* ---------- billing attempts: success rate, recovery ---------- */

export interface BillingAttemptFact {
  contractId: string;
  /** The billing cycle the attempt belongs to (e.g. the scheduled date); retries share it. */
  cycleKey: string;
  status: "success" | "failed" | "pending";
  attemptedAt: Date;
  nextRetryAt: Date | null;
  amountMinor: number;
  errorCode: string | null;
}

interface Cycle { contractId: string; cycleKey: string; attempts: BillingAttemptFact[] }
function cyclesOf(attempts: readonly BillingAttemptFact[]): Cycle[] {
  const m = new Map<string, Cycle>();
  for (const a of attempts) {
    const k = `${a.contractId}|${a.cycleKey}`;
    const c = m.get(k) ?? { contractId: a.contractId, cycleKey: a.cycleKey, attempts: [] };
    c.attempts.push(a);
    m.set(k, c);
  }
  for (const c of m.values()) c.attempts.sort((x, y) => x.attemptedAt.getTime() - y.attemptedAt.getTime());
  return [...m.values()];
}

/** Share of billing cycles that ended in a successful charge (retries included); cycles still being retried are left out. */
export function renewalSuccessRate(attempts: readonly BillingAttemptFact[]): { rate: number | null; succeeded: number; settled: number } {
  let succeeded = 0;
  let settled = 0;
  for (const c of cyclesOf(attempts)) {
    const last = c.attempts.at(-1)!;
    if (c.attempts.some((a) => a.status === "success")) { succeeded++; settled++; }
    else if (last.status === "failed" && !last.nextRetryAt) settled++;
  }
  return { rate: settled ? succeeded / settled : null, succeeded, settled };
}

export type RecoveryOutcome = "recovered" | "lost" | "open";
export interface RecoveryEpisode {
  contractId: string;
  cycleKey: string;
  outcome: RecoveryOutcome;
  failedAt: Date;
  failures: number;
  lastErrorCode: string | null;
  amountMinor: number;
  nextRetryAt: Date | null;
  recoveredAt: Date | null;
}

/**
 * Failed-payment episodes: a cycle with at least one failed charge. Recovered when a later charge of
 * the cycle succeeded; lost when the contract ended involuntarily (or the provider gave up: no retry
 * left and the contract is no longer live); open otherwise. Recovery rate = recovered / settled.
 */
export function recoveryEpisodes(attempts: readonly BillingAttemptFact[], contracts: ReadonlyMap<string, { live: boolean }>): { episodes: RecoveryEpisode[]; recovered: number; lost: number; open: number; rate: number | null } {
  const episodes: RecoveryEpisode[] = [];
  for (const c of cyclesOf(attempts)) {
    const firstFail = c.attempts.findIndex((a) => a.status === "failed");
    if (firstFail < 0) continue;
    const after = c.attempts.slice(firstFail);
    const success = after.find((a) => a.status === "success");
    const fails = after.filter((a) => a.status === "failed");
    const last = c.attempts.at(-1)!;
    const live = contracts.get(c.contractId)?.live ?? false;
    const outcome: RecoveryOutcome = success ? "recovered" : !live ? "lost" : "open";
    episodes.push({ contractId: c.contractId, cycleKey: c.cycleKey, outcome, failedAt: after[0]!.attemptedAt, failures: fails.length, lastErrorCode: fails.at(-1)?.errorCode ?? null, amountMinor: after[0]!.amountMinor, nextRetryAt: success ? null : last.nextRetryAt, recoveredAt: success?.attemptedAt ?? null });
  }
  const recovered = episodes.filter((e) => e.outcome === "recovered").length;
  const lost = episodes.filter((e) => e.outcome === "lost").length;
  return { episodes, recovered, lost, open: episodes.length - recovered - lost, rate: recovered + lost > 0 ? recovered / (recovered + lost) : null };
}

/* ---------- revenue forecast ---------- */

export interface RenewalForecast {
  days: number;
  renewals: number;
  scheduledMinor: number;
  /** Scheduled × historical success rate. */
  expectedMinor: number;
}

/** Revenue expected from scheduled renewals of active contracts over each horizon (days), at the historical success rate. */
export function forecastRenewalRevenue(contracts: readonly { status: string; nextBillingAt: Date | null; intervalUnit: string; intervalCount: number; priceMinor: number }[], asOf: Date, successRate: number, horizons: readonly number[] = [30, 60, 90]): RenewalForecast[] {
  const rate = Math.min(1, Math.max(0, successRate));
  return horizons.map((days) => {
    const until = new Date(asOf.getTime() + days * DAY);
    let renewals = 0;
    let scheduled = 0;
    for (const c of contracts) {
      if (c.status !== "active") continue;
      const n = projectRenewalDates(c, asOf, until).length;
      renewals += n;
      scheduled += n * c.priceMinor;
    }
    return { days, renewals, scheduledMinor: scheduled, expectedMinor: Math.round(scheduled * rate) };
  });
}

/* ---------- profit per subscriber and per renewal ---------- */

export interface SubscriptionOrderEconomics {
  orderId: string;
  contractId: string;
  customerId: string | null;
  /** 0 = the first order, n = the n-th renewal. */
  renewalNumber: number;
  netRevenueMinor: number;
  cogsMinor: number;
  shippingCostMinor: number;
  paymentFeeMinor: number;
  /** Margin = net revenue (after refunds and returns) − product cost − shipping − payment fees. */
  marginMinor: number;
}
export interface SubscriberProfitRow {
  contractId: string;
  customerId: string | null;
  orders: number;
  netRevenueMinor: number;
  costsMinor: number;
  profitMinor: number;
  orderIds: string[];
}

/** Profit per subscriber (contract) and the average per renewal number, from the orders' economics. */
export function subscriptionProfit(rows: readonly SubscriptionOrderEconomics[]): { subscribers: SubscriberProfitRow[]; byRenewal: { renewalNumber: number; orders: number; netRevenueMinor: number; profitMinor: number; avgProfitMinor: number }[]; totals: { orders: number; netRevenueMinor: number; costsMinor: number; profitMinor: number; avgProfitPerSubscriberMinor: number | null } } {
  const subs = new Map<string, SubscriberProfitRow>();
  const ren = new Map<number, { renewalNumber: number; orders: number; netRevenueMinor: number; profitMinor: number }>();
  for (const r of rows) {
    const s = subs.get(r.contractId) ?? { contractId: r.contractId, customerId: r.customerId, orders: 0, netRevenueMinor: 0, costsMinor: 0, profitMinor: 0, orderIds: [] };
    s.orders++;
    s.netRevenueMinor += r.netRevenueMinor;
    s.costsMinor += r.cogsMinor + r.shippingCostMinor + r.paymentFeeMinor;
    s.profitMinor += r.marginMinor;
    s.orderIds.push(r.orderId);
    subs.set(r.contractId, s);
    const b = ren.get(r.renewalNumber) ?? { renewalNumber: r.renewalNumber, orders: 0, netRevenueMinor: 0, profitMinor: 0 };
    b.orders++;
    b.netRevenueMinor += r.netRevenueMinor;
    b.profitMinor += r.marginMinor;
    ren.set(r.renewalNumber, b);
  }
  const subscribers = [...subs.values()].sort((a, b) => b.profitMinor - a.profitMinor);
  const totals = subscribers.reduce((t, s) => ({ orders: t.orders + s.orders, netRevenueMinor: t.netRevenueMinor + s.netRevenueMinor, costsMinor: t.costsMinor + s.costsMinor, profitMinor: t.profitMinor + s.profitMinor }), { orders: 0, netRevenueMinor: 0, costsMinor: 0, profitMinor: 0 });
  return { subscribers, byRenewal: [...ren.values()].sort((a, b) => a.renewalNumber - b.renewalNumber).map((b) => ({ ...b, avgProfitMinor: Math.round(b.profitMinor / b.orders) })), totals: { ...totals, avgProfitPerSubscriberMinor: subscribers.length ? Math.round(totals.profitMinor / subscribers.length) : null } };
}

export interface AcquisitionLtvRow {
  key: string;
  subscribers: number;
  revenueMinor: number;
  profitMinor: number;
  /** Realised profit to date per subscriber. */
  ltvMinor: number;
  /** Acquisition cost per subscriber (the campaign's cost per attributed order); null for unpaid channels. */
  cacMinor: number | null;
  ratio: number | null;
  contractIds: string[];
}

/** LTV (realised profit per subscriber) against acquisition cost, per campaign or channel of the first subscription order. */
export function subscriptionLtvByAcquisition(subscribers: readonly { key: string; contractId: string; revenueMinor: number; profitMinor: number }[], cacByKey: ReadonlyMap<string, number | null>): AcquisitionLtvRow[] {
  const m = new Map<string, AcquisitionLtvRow>();
  for (const s of subscribers) {
    const r = m.get(s.key) ?? { key: s.key, subscribers: 0, revenueMinor: 0, profitMinor: 0, ltvMinor: 0, cacMinor: cacByKey.get(s.key) ?? null, ratio: null, contractIds: [] };
    r.subscribers++;
    r.revenueMinor += s.revenueMinor;
    r.profitMinor += s.profitMinor;
    r.contractIds.push(s.contractId);
    m.set(s.key, r);
  }
  return [...m.values()].map((r) => {
    const ltv = Math.round(r.profitMinor / r.subscribers);
    return { ...r, ltvMinor: ltv, ratio: r.cacMinor && r.cacMinor > 0 ? ltv / r.cacMinor : null };
  }).sort((a, b) => b.subscribers - a.subscribers);
}

/* ---------- renewal stock ---------- */

export interface RenewalDemand {
  variantId: string;
  date: Date;
  units: number;
  contractId: string;
}
export interface RenewalStockRow {
  variantId: string;
  /** Units the scheduled renewals need within the horizon. */
  units: number;
  renewals: number;
  available: number;
  /** Incoming units expected before the horizon ends (no date = counted as arriving at the end). */
  incoming: number;
  /** The first renewal date the stock (with arrivals by then) cannot serve; null when covered. */
  runOutAt: Date | null;
  shortfall: number;
  suggestedQuantity: number;
  weekly: number[];
}

/**
 * Units per variant for the renewals of the next `weeks` weeks against available stock plus incoming
 * purchase orders (an arrival counts from its expected date). The run-out date is the first renewal
 * the cumulative demand cannot be served on. The shortfall is the larger of the gap left at the
 * horizon and the deepest gap before a late purchase order arrives; the suggested quantity covers it,
 * rounded up to the order multiple and at least the MOQ.
 */
export function renewalStockForecast(input: { variants: readonly { variantId: string; available: number; incoming: readonly { units: number; expectedAt: Date | null }[]; moq?: number | null; multiple?: number | null }[]; renewals: readonly RenewalDemand[]; asOf: Date; weeks: number }): RenewalStockRow[] {
  const horizon = new Date(input.asOf.getTime() + input.weeks * 7 * DAY);
  const byVariant = new Map<string, RenewalDemand[]>();
  for (const r of input.renewals) {
    if (r.date.getTime() >= horizon.getTime()) continue;
    byVariant.set(r.variantId, [...(byVariant.get(r.variantId) ?? []), r]);
  }
  const rows: RenewalStockRow[] = [];
  for (const v of input.variants) {
    const demand = (byVariant.get(v.variantId) ?? []).sort((a, b) => a.date.getTime() - b.date.getTime());
    if (!demand.length) continue;
    const weekly = Array.from({ length: input.weeks }, () => 0);
    for (const d of demand) weekly[Math.min(input.weeks - 1, Math.max(0, Math.floor((d.date.getTime() - input.asOf.getTime()) / (7 * DAY))))]! += d.units;
    const incomingBefore = v.incoming.filter((i) => !i.expectedAt || i.expectedAt.getTime() < horizon.getTime());
    let cumulative = 0;
    let runOutAt: Date | null = null;
    // the deepest gap at any renewal before the arrivals catch up: an order placed now must cover it
    let peakDeficit = 0;
    for (const d of demand) {
      cumulative += d.units;
      const arrived = incomingBefore.filter((i) => i.expectedAt && i.expectedAt.getTime() <= d.date.getTime()).reduce((s, i) => s + i.units, 0);
      const deficit = cumulative - Math.max(0, v.available) - arrived;
      if (!runOutAt && deficit > 0) runOutAt = d.date;
      peakDeficit = Math.max(peakDeficit, deficit);
    }
    const units = cumulative;
    const incoming = incomingBefore.reduce((s, i) => s + i.units, 0);
    const shortfall = Math.max(0, peakDeficit, units - Math.max(0, v.available) - incoming);
    let suggested = shortfall;
    if (suggested > 0 && v.multiple && v.multiple > 1) suggested = Math.ceil(suggested / v.multiple) * v.multiple;
    if (suggested > 0 && v.moq) suggested = Math.max(suggested, v.moq);
    rows.push({ variantId: v.variantId, units, renewals: demand.length, available: v.available, incoming, runOutAt, shortfall, suggestedQuantity: suggested, weekly });
  }
  return rows.sort((a, b) => (a.runOutAt?.getTime() ?? Infinity) - (b.runOutAt?.getTime() ?? Infinity) || b.shortfall - a.shortfall);
}

/** Reorder planning with known renewal demand: the suggestion covers at least the renewal shortfall. */
export function mergeRenewalDemand<T extends { quantity: number; shouldOrder: boolean }>(row: T, renewal: { units: number; suggestedQuantity: number; runOutAt: Date | null } | undefined): T & { renewalUnits: number; renewalRunOutAt: Date | null } {
  if (!renewal) return { ...row, renewalUnits: 0, renewalRunOutAt: null };
  const quantity = Math.max(row.quantity, renewal.suggestedQuantity);
  return { ...row, quantity, shouldOrder: row.shouldOrder || renewal.suggestedQuantity > 0, renewalUnits: renewal.units, renewalRunOutAt: renewal.runOutAt };
}

/* ---------- churn risk per subscriber ---------- */

export interface SubscriberRiskInput {
  status: string;
  /** P(active) of the customer from the CRM prediction model (0–1), null when not computed. */
  pAlive: number | null;
  /** Open failed-payment episode. */
  paymentFailing: boolean;
  skipsLast90: number;
  pausedDays: number | null;
  renewals: number;
  /** Share of contracts that cancel right after this renewal number (survival hazard), 0–1. */
  hazardNext: number | null;
  frequencyLengthened: boolean;
}
export interface SubscriberRisk {
  /** Probability-like score of staying (0–1): the CRM P(active) adjusted by subscription signals. */
  retention: number;
  risk: ChurnRisk;
  factors: { key: "p_alive" | "payment_failing" | "skips" | "paused" | "hazard" | "frequency"; impact: number }[];
}

/**
 * Churn risk of a subscriber. The base blends the survival of contracts at the subscriber's next
 * renewal number (1 − hazard) with the CRM model's P(active) for the customer (the same model as
 * the customer predictions); subscription signals then lower it, and the CRM thresholds classify it.
 */
export function subscriberChurnRisk(i: SubscriberRiskInput, th: ChurnThresholds = DEFAULT_CHURN_THRESHOLDS): SubscriberRisk {
  const factors: SubscriberRisk["factors"] = [];
  const survival = 1 - Math.min(1, Math.max(0, i.hazardNext ?? 0.05));
  const pAlive = i.pAlive ?? 0.85;
  let r = 0.6 * survival + 0.4 * pAlive;
  const round = (v: number) => Math.round(v * 100) / 100;
  if (i.pAlive !== null) factors.push({ key: "p_alive", impact: round(0.4 * (i.pAlive - 0.85)) });
  if (i.hazardNext !== null) factors.push({ key: "hazard", impact: round(-0.6 * (i.hazardNext - 0.05)) });
  const hit = (key: SubscriberRisk["factors"][number]["key"], mult: number) => {
    const before = r;
    r *= mult;
    factors.push({ key, impact: round(r - before) });
  };
  if (i.paymentFailing) hit("payment_failing", 0.55);
  if (i.skipsLast90 > 0) hit("skips", Math.max(0.6, 1 - 0.12 * i.skipsLast90));
  if (i.status === "paused") hit("paused", i.pausedDays !== null && i.pausedDays > 30 ? 0.5 : 0.8);
  if (i.frequencyLengthened) hit("frequency", 0.85);
  const retention = Math.min(1, Math.max(0, r));
  return { retention, risk: churnRiskOf(retention, th), factors };
}

/** Hazard per renewal number from survival: the share of contracts that reached renewal n and ended before n + 1. */
export function renewalHazards(contracts: readonly { renewals: number; ended: boolean }[], maxN = 24): number[] {
  const out: number[] = [];
  for (let n = 0; n <= maxN; n++) {
    const reached = contracts.filter((c) => c.renewals >= n);
    const ended = reached.filter((c) => c.renewals === n && c.ended).length;
    out.push(reached.length ? ended / reached.length : 0);
  }
  return out;
}

/* ---------- cancellation reasons ---------- */

export interface CancellationReasonDef {
  code: string;
  label: string;
  kind: CancellationKind;
  /** Lower-case fragments that map a provider's free text onto this reason (any language). */
  keywords: readonly string[];
}

/** Starting list for a tenant (editable in the add-on): codes are stable, labels and keywords are the tenant's. */
export const DEFAULT_CANCELLATION_REASONS: readonly CancellationReasonDef[] = [
  { code: "too_expensive", label: "Too expensive", kind: "voluntary", keywords: ["expensive", "price", "cost", "afford", "caro", "prezzo", "costoso", "precio"] },
  { code: "too_much_product", label: "Too much product", kind: "voluntary", keywords: ["too much", "too many", "stock up", "surplus", "troppo", "demasiado", "have enough", "piling"] },
  { code: "not_needed", label: "No longer needed", kind: "voluntary", keywords: ["no longer", "don't need", "dont need", "not need", "non serve", "ya no", "no necesito"] },
  { code: "quality", label: "Product quality", kind: "voluntary", keywords: ["quality", "scent", "smell", "didn't like", "qualità", "calidad", "broke"] },
  { code: "switched", label: "Switched to another brand", kind: "voluntary", keywords: ["another brand", "competitor", "switch", "cheaper elsewhere", "altro marchio", "otra marca"] },
  { code: "delivery", label: "Delivery problems", kind: "voluntary", keywords: ["delivery", "shipping", "late", "arrived", "consegna", "spedizione", "envío", "entrega"] },
  { code: "moving", label: "Moving or travelling", kind: "voluntary", keywords: ["moving", "travel", "trasloco", "viaggio", "mudanza", "viaje"] },
  { code: "payment_failed", label: "Payment failed", kind: "involuntary", keywords: ["payment", "card", "declined", "max retries", "billing failed", "pagamento", "pago", "tarjeta"] },
  { code: "other", label: "Other", kind: "voluntary", keywords: [] },
];

/** Maps a provider's raw reason (code or free text) onto the tenant's list; unknown text is `other`, the raw text is kept by the caller. */
export function normalizeCancellationReason(raw: string | null | undefined, reasons: readonly CancellationReasonDef[] = DEFAULT_CANCELLATION_REASONS, opts: { involuntary?: boolean } = {}): string {
  const fallback = opts.involuntary && reasons.some((r) => r.code === "payment_failed") ? "payment_failed" : reasons.some((r) => r.code === "other") ? "other" : (reasons[0]?.code ?? "other");
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return fallback;
  const byCode = reasons.find((r) => r.code === text.replace(/[\s-]+/g, "_"));
  if (byCode) return byCode.code;
  for (const r of reasons) if (r.keywords.some((k) => k && text.includes(k.toLowerCase()))) return r.code;
  return fallback;
}

export interface CancellationFact {
  reasonCode: string;
  /** Product, cohort or channel the cancellation belongs to (the breakdown dimension). */
  dimension: string;
  /** `YYYY-MM` of the cancellation. */
  month: string;
  contractId: string;
}
/** Cancellations by reason, by reason × dimension (product, cohort or channel) and by month (trend). */
export function cancellationBreakdown(rows: readonly CancellationFact[]): { total: number; byReason: { reasonCode: string; count: number; share: number }[]; matrix: { dimension: string; total: number; byReason: Record<string, number> }[]; trend: { month: string; total: number; byReason: Record<string, number> }[] } {
  const reasons = new Map<string, number>();
  const dims = new Map<string, { dimension: string; total: number; byReason: Record<string, number> }>();
  const months = new Map<string, { month: string; total: number; byReason: Record<string, number> }>();
  for (const r of rows) {
    reasons.set(r.reasonCode, (reasons.get(r.reasonCode) ?? 0) + 1);
    const d = dims.get(r.dimension) ?? { dimension: r.dimension, total: 0, byReason: {} };
    d.total++;
    d.byReason[r.reasonCode] = (d.byReason[r.reasonCode] ?? 0) + 1;
    dims.set(r.dimension, d);
    const m = months.get(r.month) ?? { month: r.month, total: 0, byReason: {} };
    m.total++;
    m.byReason[r.reasonCode] = (m.byReason[r.reasonCode] ?? 0) + 1;
    months.set(r.month, m);
  }
  const total = rows.length;
  return {
    total,
    byReason: [...reasons.entries()].map(([reasonCode, count]) => ({ reasonCode, count, share: total ? count / total : 0 })).sort((a, b) => b.count - a.count),
    matrix: [...dims.values()].sort((a, b) => b.total - a.total),
    trend: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

/* ---------- segment fields (kept apart from the core catalog to ease merges) ---------- */

/** Subscription fields of the segment builder; offered only with `addon.subscriptions` (group `subscriptions`). */
export const SUBSCRIPTION_SEGMENT_FIELDS: Record<string, SegmentFieldDef> = {
  subscription_status: { type: "enum", values: ["active", "paused", "cancelled", "expired", "failed", "none"], group: "subscriptions" },
  subscription_paused_days: { type: "days", group: "subscriptions" },
  subscription_payment_failed: { type: "boolean", group: "subscriptions" },
  subscription_renewals: { type: "number", group: "subscriptions" },
  subscription_next_renewal_days: { type: "days", group: "subscriptions" },
  subscription_churn_risk: { type: "enum", values: ["low", "medium", "high"], group: "subscriptions" },
};
export const SUBSCRIPTION_SEGMENT_GROUP = "subscriptions";

/** The subscription signals of one customer (their most relevant contract), for in-memory evaluation. */
export interface SubscriberSignals {
  status: string;
  pausedDays: number | null;
  paymentFailed: boolean;
  renewals: number;
  nextRenewalDays: number | null;
  churnRisk: string | null;
}
export function subscriptionProfileValue(s: SubscriberSignals | null | undefined, field: string): unknown {
  switch (field) {
    case "subscription_status": return s?.status ?? "none";
    case "subscription_paused_days": return s?.pausedDays ?? null;
    case "subscription_payment_failed": return s?.paymentFailed ?? false;
    case "subscription_renewals": return s?.renewals ?? 0;
    case "subscription_next_renewal_days": return s?.nextRenewalDays ?? null;
    case "subscription_churn_risk": return s?.churnRisk ?? null;
    default: return undefined;
  }
}

export const READY_MADE_SUBSCRIPTION_SEGMENTS = ["paused_30", "payment_failed", "renewal_n", "high_churn_risk"] as const;
export type ReadyMadeSubscriptionSegment = (typeof READY_MADE_SUBSCRIPTION_SEGMENTS)[number];

/** Rules of the ready-made segments; "about to hit renewal N" = N − 1 renewals done and the next one within 7 days. */
export function readyMadeSubscriptionSegment(key: ReadyMadeSubscriptionSegment, opts: { renewal?: number } = {}): SegmentGroup {
  switch (key) {
    case "paused_30": return { match: "all", conditions: [{ field: "subscription_status", op: "in", value: ["paused"] }, { field: "subscription_paused_days", op: "gte", value: 30 }] };
    case "payment_failed": return { match: "all", conditions: [{ field: "subscription_payment_failed", op: "eq", value: true }] };
    case "renewal_n": return { match: "all", conditions: [{ field: "subscription_status", op: "in", value: ["active"] }, { field: "subscription_renewals", op: "eq", value: Math.max(0, (opts.renewal ?? 3) - 1) }, { field: "subscription_next_renewal_days", op: "lte", value: 7 }] };
    case "high_churn_risk": return { match: "all", conditions: [{ field: "subscription_status", op: "in", value: ["active", "paused"] }, { field: "subscription_churn_risk", op: "in", value: ["high"] }] };
  }
}
