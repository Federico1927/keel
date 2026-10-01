import { describe, expect, it } from "vitest";
import { cacPaybackDays, cohortLtv, cumulativeAt, median, pairLift, type CustomerTimeline } from "./ltv";

const d = (iso: string) => new Date(iso);
const customers: CustomerTimeline[] = [
  { customerId: "a", keys: { cohort: "2026-01", channel: "paid_social" }, orders: [{ at: d("2026-01-10"), netMinor: 10_000, marginMinor: 4_000 }, { at: d("2026-02-20"), netMinor: 8_000, marginMinor: 3_000 }, { at: d("2026-07-01"), netMinor: 12_000, marginMinor: 5_000 }] },
  { customerId: "b", keys: { cohort: "2026-01", channel: "direct" }, orders: [{ at: d("2026-01-25"), netMinor: 6_000, marginMinor: 2_000 }] },
  { customerId: "c", keys: { cohort: "2026-09", channel: "paid_social" }, orders: [{ at: d("2026-09-20"), netMinor: 9_000, marginMinor: 3_500 }] },
];

describe("ltv", () => {
  it("accumulates value inside a window from the first order", () => {
    expect(cumulativeAt(customers[0]!, 30)).toEqual({ netMinor: 10_000, marginMinor: 4_000, orders: 1 });
    expect(cumulativeAt(customers[0]!, 60)).toEqual({ netMinor: 18_000, marginMinor: 7_000, orders: 2 });
    expect(cumulativeAt(customers[0]!, 365).orders).toBe(3);
  });
  it("only counts matured customers per window and groups by any key", () => {
    const rows = cohortLtv(customers, "cohort", d("2026-10-01"));
    const jan = rows.find((r) => r.key === "2026-01")!;
    expect(jan.customers).toBe(2);
    const w60 = jan.windows.find((w) => w.window === 60)!;
    expect(w60.matured).toBe(2);
    expect(w60.avgNetMinor).toBe(12_000);
    expect(w60.repeatRate).toBe(0.5);
    const w365 = jan.windows.find((w) => w.window === 365)!;
    expect(w365.matured).toBe(0);
    expect(w365.avgNetMinor).toBeNull();
    expect(jan.medianDaysToSecond).toBe(41);
    const sep = rows.find((r) => r.key === "2026-09")!;
    expect(sep.windows.find((w) => w.window === 30)!.matured).toBe(0);
    const byChannel = cohortLtv(customers, "channel", d("2026-10-01"));
    expect(byChannel.map((r) => r.key).sort()).toEqual(["direct", "paid_social"]);
  });
  it("interpolates CAC payback between windows", () => {
    const windows = cohortLtv(customers, "cohort", d("2026-10-01")).find((r) => r.key === "2026-01")!.windows;
    // margins: 30d 3000, 60d 4500 → CAC 3750 reached at day 45
    expect(cacPaybackDays(windows, 3_750)).toBe(45);
    expect(cacPaybackDays(windows, 100_000)).toBeNull();
    expect(cacPaybackDays(windows, null)).toBeNull();
  });
  it("median and pair lift", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBeNull();
    expect(pairLift(100, 50, 20, 1000)).toBe(4);
    expect(pairLift(0, 50, 0, 1000)).toBeNull();
  });
});
