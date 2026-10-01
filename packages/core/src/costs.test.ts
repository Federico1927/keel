import { describe, expect, it } from "vitest";
import { blendedMetrics, forecastMonthEnd, monthCoverage, monthsBetween, resolveFixedCosts, resolveShippingCosts } from "./costs";

describe("period costs", () => {
  const from = new Date(Date.UTC(2026, 7, 16)); // 16 Aug
  const to = new Date(Date.UTC(2026, 9, 1)); // 1 Oct (exclusive)
  it("lists overlapping months and their coverage", () => {
    expect(monthsBetween(from, to)).toEqual(["2026-08", "2026-09"]);
    expect(monthCoverage("2026-08", from, to)).toBeCloseTo(16 / 31, 5);
    expect(monthCoverage("2026-09", from, to)).toBe(1);
    expect(monthCoverage("2026-10", from, to)).toBe(0);
  });
  it("uses actual over estimate per line, falls back to the legacy monthly amount, prorates partial months", () => {
    const entries = [
      { period: "2026-09", kind: "fixed" as const, label: "Software", estimateMinor: 100_000, actualMinor: 110_000 },
      { period: "2026-09", kind: "fixed" as const, label: "Agency", estimateMinor: 50_000, actualMinor: null },
    ];
    const r = resolveFixedCosts(entries, from, to, () => 62_000);
    expect(r.byMonth).toEqual([
      { period: "2026-08", usedMinor: Math.round(62_000 * (16 / 31)), source: "legacy", coverage: 16 / 31 },
      { period: "2026-09", usedMinor: 160_000, source: "mixed", coverage: 1 },
    ]);
    expect(r.totalMinor).toBe(32_000 + 160_000);
    expect(r.source).toBe("mixed");
    expect(resolveFixedCosts([], from, to).source).toBe("none");
  });
  it("replaces the per-order shipping estimate with the carrier invoice month by month", () => {
    const r = resolveShippingCosts({ "2026-08": 40_000, "2026-09": 75_000 }, [{ period: "2026-09", kind: "shipping", label: "", estimateMinor: 70_000, actualMinor: 81_500 }], from, to);
    expect(r.byMonth.map((m) => [m.period, m.usedMinor, m.source])).toEqual([
      ["2026-08", 40_000, "estimate"],
      ["2026-09", 81_500, "actual"],
    ]);
    expect(r.totalMinor).toBe(121_500);
  });
});

describe("blended metrics", () => {
  it("computes MER, nc-ROAS, CAC, POAS and CAC by channel; null when the denominator is zero", () => {
    const m = blendedMetrics({ netRevenueMinor: 1_000_000, adSpendMinor: 250_000, orders: 400, newCustomers: 125, newCustomerRevenueMinor: 375_000, contributionMinor: 420_000, byChannel: [{ channel: "meta", spendMinor: 200_000, newCustomers: 100 }, { channel: "google", spendMinor: 50_000, newCustomers: 0 }] });
    expect(m.mer).toBe(4);
    expect(m.ncRoas).toBe(1.5);
    expect(m.cacMinor).toBe(2000);
    expect(m.poas).toBe(1.68);
    expect(m.spendShare).toBe(0.25);
    expect(m.cacByChannel).toEqual([
      { channel: "meta", spendMinor: 200_000, newCustomers: 100, cacMinor: 2000 },
      { channel: "google", spendMinor: 50_000, newCustomers: 0, cacMinor: null },
    ]);
    expect(blendedMetrics({ netRevenueMinor: 0, adSpendMinor: 0, orders: 0, newCustomers: 0, newCustomerRevenueMinor: 0, contributionMinor: 0 }).mer).toBeNull();
  });
});

describe("month-end forecast", () => {
  it("projects by run rate with a band and respects a weekday profile", () => {
    const flat = forecastMonthEnd({ dailyToDate: [100, 100, 100, 100, 100], daysInMonth: 30 });
    expect(flat).toMatchObject({ toDate: 500, projected: 3000, low: 3000, high: 3000, dailyRunRate: 100, remainingDays: 25 });
    const noisy = forecastMonthEnd({ dailyToDate: [80, 120, 90, 110], daysInMonth: 10 });
    expect(noisy.projected).toBe(1000);
    expect(noisy.low).toBeLessThan(1000);
    expect(noisy.high).toBeGreaterThan(1000);
    // weekends sell half: a month whose remaining days are all weekend projects less than flat
    const profile = [0.05, 0.18, 0.18, 0.18, 0.18, 0.18, 0.05];
    const weekdaysOnly = forecastMonthEnd({ dailyToDate: [180, 180, 180, 180, 180], daysInMonth: 7, weekdayProfile: profile, firstWeekday: 1 });
    expect(weekdaysOnly.projected).toBeLessThan(180 * 7);
    expect(forecastMonthEnd({ dailyToDate: [], daysInMonth: 30 }).projected).toBe(0);
  });
});
