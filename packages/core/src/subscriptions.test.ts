import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANCELLATION_REASONS,
  NO_SUBSCRIPTION_CAPABILITIES,
  addSubscriptionInterval,
  cancellationBreakdown,
  forecastRenewalRevenue,
  mergeRenewalDemand,
  normalizeCancellationReason,
  projectRenewalDates,
  readyMadeSubscriptionSegment,
  recoveryEpisodes,
  renewalHazards,
  renewalStockForecast,
  renewalSuccessRate,
  subscriberChurnRisk,
  subscriberCounts,
  subscriptionActionAllowed,
  subscriptionLtvByAcquisition,
  subscriptionMonthlyAmount,
  subscriptionMrrMovement,
  subscriptionProfit,
  subscriptionSurvivalCohorts,
  timelineMrrAt,
  type BillingAttemptFact,
  type SubscriptionTimeline,
} from "./subscriptions";
import { evaluateRules, validateSegmentRules, type CustomerProfile } from "./segments";

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const tl = (o: Partial<SubscriptionTimeline> & { contractId: string; activatedAt: Date; mrrMinor?: number }): SubscriptionTimeline => ({ customerId: o.customerId ?? `cust-${o.contractId}`, endedAt: null, endKind: null, pauses: [], mrr: o.mrr ?? [{ from: o.activatedAt, mrrMinor: o.mrrMinor ?? 3000 }], ...o });

describe("normalization", () => {
  it("turns any interval into a monthly amount", () => {
    expect(subscriptionMonthlyAmount(3000, "month", 1)).toBe(3000);
    expect(subscriptionMonthlyAmount(3000, "month", 2)).toBe(1500);
    expect(subscriptionMonthlyAmount(1200, "week", 4)).toBe(1300); // 1200 × 52/12 / 4
    expect(subscriptionMonthlyAmount(12000, "year", 1)).toBe(1000);
    expect(subscriptionMonthlyAmount(100, "day", 30)).toBe(101); // 100 × 365/12 / 30
  });
  it("projects billing dates, an overdue one counted once today", () => {
    const asOf = d("2026-10-02");
    expect(projectRenewalDates({ nextBillingAt: d("2026-10-10"), intervalUnit: "month", intervalCount: 1 }, asOf, d("2026-12-31")).map((x) => x.toISOString().slice(0, 10))).toEqual(["2026-10-10", "2026-11-10", "2026-12-10"]);
    expect(projectRenewalDates({ nextBillingAt: d("2026-09-28"), intervalUnit: "week", intervalCount: 2 }, asOf, d("2026-10-31")).map((x) => x.toISOString().slice(0, 10))).toEqual(["2026-10-02", "2026-10-12", "2026-10-26"]);
    expect(addSubscriptionInterval(d("2026-01-31"), "month", 1).toISOString().slice(0, 10)).toBe("2026-03-03");
  });
  it("offers an action only with the capability and in a status that allows it", () => {
    const caps = { ...NO_SUBSCRIPTION_CAPABILITIES, canPause: true, canSkip: true };
    expect(subscriptionActionAllowed("pause", "active", caps)).toBe(true);
    expect(subscriptionActionAllowed("pause", "paused", caps)).toBe(false);
    expect(subscriptionActionAllowed("skip", "cancelled", caps)).toBe(false);
    expect(subscriptionActionAllowed("cancel", "active", caps)).toBe(false);
  });
});

/*
 * Hand-calculated fixture (October 2026):
 *  A: active since Jan, 3000/month                         → start 3000, end 3000 (no change)
 *  B: active since Mar, 2000 → 2500 on Oct 10 (swap)      → expansion 500
 *  C: active since Feb, 4000, cancelled Oct 5 voluntarily → churned 4000
 *  D: active since Apr, 1500, paused Oct 12 (open)         → contraction 1500 (paused = 0 MRR)
 *  E: new on Oct 20, 3500                                  → new 3500
 *  F: ended Jun (involuntary), new contract Oct 15 at 1000 → reactivated 1000
 *  G: active since May, 2200, failed payment → ended Oct 25 involuntarily → churned 2200
 * Start MRR = 3000 + 2000 + 4000 + 1500 + 2200 = 12700; end = 3000 + 2500 + 0 + 3500 + 1000 = 10000.
 * 12700 + 3500 + 500 + 1000 − 1500 − 4000 − 2200 = 10000.
 */
const oct = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
const fixture: SubscriptionTimeline[] = [
  tl({ contractId: "A", activatedAt: d("2026-01-10"), mrrMinor: 3000 }),
  tl({ contractId: "B", activatedAt: d("2026-03-03"), mrr: [{ from: d("2026-03-03"), mrrMinor: 2000 }, { from: d("2026-10-10"), mrrMinor: 2500 }] }),
  tl({ contractId: "C", activatedAt: d("2026-02-01"), mrrMinor: 4000, endedAt: d("2026-10-05"), endKind: "voluntary" }),
  tl({ contractId: "D", activatedAt: d("2026-04-15"), mrrMinor: 1500, pauses: [{ from: d("2026-10-12"), to: null }] }),
  tl({ contractId: "E", activatedAt: d("2026-10-20"), mrrMinor: 3500 }),
  tl({ contractId: "F1", customerId: "cust-F", activatedAt: d("2026-01-05"), mrrMinor: 1000, endedAt: d("2026-06-05"), endKind: "involuntary" }),
  tl({ contractId: "F2", customerId: "cust-F", activatedAt: d("2026-10-15"), mrrMinor: 1000 }),
  tl({ contractId: "G", activatedAt: d("2026-05-02"), mrrMinor: 2200, endedAt: d("2026-10-25"), endKind: "involuntary" }),
];

describe("MRR, subscribers and churn (hand calculation)", () => {
  it("splits the month's MRR movement and reconciles start to end", () => {
    const m = subscriptionMrrMovement(fixture, oct);
    expect(m).toMatchObject({ startMrrMinor: 12700, newMinor: 3500, expansionMinor: 500, contractionMinor: 1500, churnedMinor: 6200, reactivatedMinor: 1000, endMrrMinor: 10000 });
    expect(m.startMrrMinor + m.newMinor + m.expansionMinor + m.reactivatedMinor - m.contractionMinor - m.churnedMinor).toBe(m.endMrrMinor);
    expect(m.customers.churned.sort()).toEqual(["cust-C", "cust-G"]);
    expect(m.customers.reactivated).toEqual(["cust-F"]);
    expect(timelineMrrAt(fixture[3]!, d("2026-10-11"))).toBe(1500);
    expect(timelineMrrAt(fixture[3]!, d("2026-10-13"))).toBe(0);
  });
  it("counts subscribers and splits churn voluntary vs involuntary", () => {
    const c = subscriberCounts(fixture, oct);
    // live at the start: A, B, C, D, G = 5; cancelled C (voluntary), G (involuntary)
    expect(c).toMatchObject({ liveAtStart: 5, active: 4, paused: 1, new: 2, cancelled: 2, voluntary: 1, involuntary: 1 });
    expect(c.churnRate).toBeCloseTo(0.4);
    expect(c.voluntaryRate).toBeCloseTo(0.2);
    expect(c.involuntaryRate).toBeCloseTo(0.2);
    expect(c.ids.active.sort()).toEqual(["A", "B", "E", "F2"]);
  });
  it("builds survival cohorts by activation month", () => {
    const cohorts = subscriptionSurvivalCohorts([
      tl({ contractId: "1", activatedAt: d("2026-01-10") }),
      tl({ contractId: "2", activatedAt: d("2026-01-20"), endedAt: d("2026-02-25"), endKind: "voluntary" }),
      tl({ contractId: "3", activatedAt: d("2026-01-25"), endedAt: d("2026-04-01"), endKind: "involuntary" }),
      tl({ contractId: "4", activatedAt: d("2026-02-14") }),
    ], d("2026-04-15"), { months: 3, timeZone: "UTC" });
    expect(cohorts.map((c) => c.cohort)).toEqual(["2026-01", "2026-02"]);
    // Jan: month 1 → all 3 alive (2 ends 02-25 > 02-20); month 2 → 1 and 3 alive (2/3); month 3 → only contract 1 is old enough (04-10; 04-20 and 04-25 are after asOf) and alive: 1/1
    expect(cohorts[0]).toMatchObject({ size: 3, eligible: [3, 3, 3, 1] });
    expect(cohorts[0]!.retention[1]).toBe(1);
    expect(cohorts[0]!.retention[2]).toBeCloseTo(2 / 3);
    expect(cohorts[0]!.retention[3]).toBe(1);
    expect(cohorts[1]!.retention).toEqual([1, 1, 1, null]); // 02-14 + 2 months = 04-14 ≤ asOf
  });
});

describe("billing attempts", () => {
  const a = (contractId: string, cycleKey: string, status: BillingAttemptFact["status"], at: string, nextRetry: string | null = null, errorCode: string | null = null): BillingAttemptFact => ({ contractId, cycleKey, status, attemptedAt: d(at), nextRetryAt: nextRetry ? d(nextRetry) : null, amountMinor: 3000, errorCode });
  const attempts = [
    a("A", "c1", "success", "2026-09-01"),
    a("B", "c1", "failed", "2026-09-01", "2026-09-04", "insufficient_funds"), a("B", "c1", "success", "2026-09-04"),
    a("C", "c1", "failed", "2026-09-10", "2026-09-13", "card_expired"), a("C", "c1", "failed", "2026-09-13", null, "card_expired"),
    a("D", "c1", "failed", "2026-09-28", "2026-10-03", "card_declined"),
  ];
  it("measures the eventual success rate per billing cycle", () => {
    // A ok, B recovered, C given up, D still retrying (left out) → 2 / 3
    expect(renewalSuccessRate(attempts)).toEqual({ rate: 2 / 3, succeeded: 2, settled: 3 });
  });
  it("tracks failed-payment episodes and the recovery rate", () => {
    const r = recoveryEpisodes(attempts, new Map([["A", { live: true }], ["B", { live: true }], ["C", { live: false }], ["D", { live: true }]]));
    expect(r.episodes.map((e) => [e.contractId, e.outcome])).toEqual([["B", "recovered"], ["C", "lost"], ["D", "open"]]);
    expect(r.rate).toBe(0.5);
    expect(r.episodes.find((e) => e.contractId === "D")!.nextRetryAt?.toISOString().slice(0, 10)).toBe("2026-10-03");
  });
  it("forecasts 30/60/90-day revenue from scheduled renewals at the success rate", () => {
    const asOf = d("2026-10-02");
    const f = forecastRenewalRevenue([
      { status: "active", nextBillingAt: d("2026-10-05"), intervalUnit: "month", intervalCount: 1, priceMinor: 3000 },
      { status: "active", nextBillingAt: d("2026-11-20"), intervalUnit: "month", intervalCount: 2, priceMinor: 5000 },
      { status: "paused", nextBillingAt: d("2026-10-06"), intervalUnit: "month", intervalCount: 1, priceMinor: 9999 },
    ], asOf, 0.9);
    expect(f).toEqual([
      { days: 30, renewals: 1, scheduledMinor: 3000, expectedMinor: 2700 },
      { days: 60, renewals: 3, scheduledMinor: 11000, expectedMinor: 9900 },
      { days: 90, renewals: 4, scheduledMinor: 14000, expectedMinor: 12600 },
    ]);
  });
});

describe("profit and LTV", () => {
  it("profit per subscriber is revenue minus product cost, shipping and fees", () => {
    const p = subscriptionProfit([
      { orderId: "o1", contractId: "A", customerId: "c1", renewalNumber: 0, netRevenueMinor: 3000, cogsMinor: 900, shippingCostMinor: 500, paymentFeeMinor: 117, marginMinor: 1483 },
      { orderId: "o2", contractId: "A", customerId: "c1", renewalNumber: 1, netRevenueMinor: 3000, cogsMinor: 900, shippingCostMinor: 500, paymentFeeMinor: 117, marginMinor: 1483 },
      { orderId: "o3", contractId: "B", customerId: "c2", renewalNumber: 0, netRevenueMinor: 2000, cogsMinor: 700, shippingCostMinor: 500, paymentFeeMinor: 88, marginMinor: 712 },
    ]);
    expect(p.totals).toEqual({ orders: 3, netRevenueMinor: 8000, costsMinor: 4322, profitMinor: 3678, avgProfitPerSubscriberMinor: 1839 });
    expect(p.subscribers[0]).toMatchObject({ contractId: "A", orders: 2, profitMinor: 2966, orderIds: ["o1", "o2"] });
    expect(p.byRenewal).toEqual([{ renewalNumber: 0, orders: 2, netRevenueMinor: 5000, profitMinor: 2195, avgProfitMinor: 1098 }, { renewalNumber: 1, orders: 1, netRevenueMinor: 3000, profitMinor: 1483, avgProfitMinor: 1483 }]);
  });
  it("compares realised LTV with the acquisition cost per campaign or channel", () => {
    const rows = subscriptionLtvByAcquisition([
      { key: "camp-1", contractId: "A", revenueMinor: 9000, profitMinor: 4000 },
      { key: "camp-1", contractId: "B", revenueMinor: 3000, profitMinor: 1000 },
      { key: "organic", contractId: "C", revenueMinor: 6000, profitMinor: 2500 },
    ], new Map([["camp-1", 2000], ["organic", null]]));
    expect(rows[0]).toMatchObject({ key: "camp-1", subscribers: 2, ltvMinor: 2500, cacMinor: 2000, ratio: 1.25 });
    expect(rows[1]).toMatchObject({ key: "organic", ltvMinor: 2500, cacMinor: null, ratio: null });
  });
});

describe("renewal stock", () => {
  const asOf = d("2026-10-02");
  const ren = (variantId: string, day: string, units: number, n: number) => ({ variantId, date: d(day), units, contractId: `c${n}` });
  it("flags the variant that runs out before the renewals and suggests the shortfall rounded to the multiple", () => {
    const rows = renewalStockForecast({
      asOf,
      weeks: 2,
      variants: [
        { variantId: "V1", available: 5, incoming: [{ units: 10, expectedAt: d("2026-10-12") }], multiple: 6 },
        { variantId: "V2", available: 50, incoming: [] },
      ],
      renewals: [ren("V1", "2026-10-04", 3, 1), ren("V1", "2026-10-06", 4, 2), ren("V1", "2026-10-13", 10, 3), ren("V1", "2026-10-30", 9, 4), ren("V2", "2026-10-05", 2, 5)],
    });
    expect(rows[0]).toMatchObject({ variantId: "V1", units: 17, renewals: 3, available: 5, incoming: 10, shortfall: 2, suggestedQuantity: 6, weekly: [7, 10] });
    // 3 then 7 > 5 on Oct 6, before the PO arrives on Oct 12
    expect(rows[0]!.runOutAt?.toISOString().slice(0, 10)).toBe("2026-10-06");
    expect(rows[1]).toMatchObject({ variantId: "V2", runOutAt: null, shortfall: 0, suggestedQuantity: 0 });
    expect(mergeRenewalDemand({ quantity: 0, shouldOrder: false }, rows[0])).toMatchObject({ quantity: 6, shouldOrder: true, renewalUnits: 17 });
    expect(mergeRenewalDemand({ quantity: 24, shouldOrder: true }, rows[0])).toMatchObject({ quantity: 24 });
  });
});

describe("retention", () => {
  it("adjusts the CRM P(active) with subscription signals", () => {
    const calm = subscriberChurnRisk({ status: "active", pAlive: 0.9, paymentFailing: false, skipsLast90: 0, pausedDays: null, renewals: 5, hazardNext: 0.02, frequencyLengthened: false });
    expect(calm.risk).toBe("low");
    const bad = subscriberChurnRisk({ status: "paused", pAlive: 0.8, paymentFailing: true, skipsLast90: 2, pausedDays: 45, renewals: 2, hazardNext: 0.2, frequencyLengthened: true });
    expect(bad.risk).toBe("high");
    expect(bad.factors.map((f) => f.key)).toEqual(["p_alive", "hazard", "payment_failing", "skips", "paused", "frequency"]);
    // 0.6 × (1 − 0.2) + 0.4 × 0.8 = 0.8, × 0.55 × 0.76 × 0.5 × 0.85
    expect(bad.retention).toBeCloseTo(0.8 * 0.55 * 0.76 * 0.5 * 0.85);
    expect(subscriberChurnRisk({ status: "active", pAlive: null, paymentFailing: true, skipsLast90: 0, pausedDays: null, renewals: 1, hazardNext: 0.1, frequencyLengthened: false }).risk).toBe("medium");
    expect(renewalHazards([{ renewals: 0, ended: true }, { renewals: 2, ended: false }, { renewals: 1, ended: true }], 2)).toEqual([1 / 3, 1 / 2, 0]);
  });
  it("normalizes cancellation reasons and keeps unknown text as other", () => {
    expect(normalizeCancellationReason("It's too expensive for me")).toBe("too_expensive");
    expect(normalizeCancellationReason("TOO_MUCH_PRODUCT")).toBe("too_much_product");
    expect(normalizeCancellationReason("Ho troppo prodotto in casa")).toBe("too_much_product");
    expect(normalizeCancellationReason("asdf")).toBe("other");
    expect(normalizeCancellationReason(null, DEFAULT_CANCELLATION_REASONS, { involuntary: true })).toBe("payment_failed");
  });
  it("breaks cancellations down by reason, dimension and month", () => {
    const b = cancellationBreakdown([
      { reasonCode: "too_expensive", dimension: "Candle Refill", month: "2026-08", contractId: "1" },
      { reasonCode: "too_expensive", dimension: "Candle Refill", month: "2026-09", contractId: "2" },
      { reasonCode: "too_much_product", dimension: "Cleaning Refill", month: "2026-09", contractId: "3" },
    ]);
    expect(b.byReason[0]).toEqual({ reasonCode: "too_expensive", count: 2, share: 2 / 3 });
    expect(b.matrix[0]).toEqual({ dimension: "Candle Refill", total: 2, byReason: { too_expensive: 2 } });
    expect(b.trend.map((t) => [t.month, t.total])).toEqual([["2026-08", 1], ["2026-09", 2]]);
  });
  it("ready-made segments validate and evaluate on subscription signals", () => {
    const base: CustomerProfile = { customerId: "x", ordersCount: 3, cancelledCount: 0, returnsCount: 0, totalSpentMinor: 9000, aovMinor: 3000, daysSinceLastOrder: 10, daysSinceFirstOrder: 100, acceptsMarketing: true, country: "US", tags: [], paymentMethods: ["card"], productIds: [], productTypes: [], randomPct: 1 };
    for (const k of ["paused_30", "payment_failed", "renewal_n", "high_churn_risk"] as const) expect(validateSegmentRules(readyMadeSubscriptionSegment(k)).errors).toEqual([]);
    const paused = { ...base, subscription: { status: "paused", pausedDays: 40, paymentFailed: false, renewals: 2, nextRenewalDays: null, churnRisk: "medium" } };
    expect(evaluateRules(readyMadeSubscriptionSegment("paused_30"), paused)).toBe(true);
    expect(evaluateRules(readyMadeSubscriptionSegment("payment_failed"), paused)).toBe(false);
    const due = { ...base, subscription: { status: "active", pausedDays: null, paymentFailed: false, renewals: 2, nextRenewalDays: 3, churnRisk: "low" } };
    expect(evaluateRules(readyMadeSubscriptionSegment("renewal_n", { renewal: 3 }), due)).toBe(true);
    expect(evaluateRules(readyMadeSubscriptionSegment("paused_30"), base)).toBe(false);
  });
});
