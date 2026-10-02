import { describe, expect, it } from "vitest";
import { MODULES, PLANS, type PlanKey, type TenantStatus } from "@keel/config";
import { mrr } from "./billing";
import { canTransition, lastMonths, monthlyChargeMinor, platformSeries, subscriptionStatusFor, tenantHealth, type LifecycleSnapshot } from "./platform";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("tenant lifecycle", () => {
  it("allows the documented moves and refuses the others", () => {
    expect(canTransition("trial", "active")).toBe(true);
    expect(canTransition("active", "past_due")).toBe(true);
    expect(canTransition("past_due", "suspended")).toBe(true);
    expect(canTransition("suspended", "active")).toBe(true);
    expect(canTransition("suspended", "churned")).toBe(true);
    expect(canTransition("churned", "active")).toBe(true);
    expect(canTransition("active", "trial")).toBe(false);
    expect(canTransition("churned", "suspended")).toBe(false);
    expect(canTransition("active", "active")).toBe(false);
  });
  it("mirrors the state on the subscription whatever the provider", () => {
    expect(subscriptionStatusFor("trial")).toBe("trialing");
    expect(subscriptionStatusFor("churned")).toBe("cancelled");
    expect(subscriptionStatusFor("past_due")).toBe("past_due");
  });
});

describe("platform series", () => {
  /** Subscriptions described as periods of one status, the way a person would read a billing history. */
  interface Sub {
    tenantId: string;
    periods: { from: string; status: TenantStatus; planKey: PlanKey; addons: string[] }[];
  }
  const subs: Sub[] = [
    { tenantId: "a", periods: [{ from: "2026-01-10", status: "trial", planKey: "growth", addons: [] }, { from: "2026-01-24", status: "active", planKey: "growth", addons: ["addon.cod"] }, { from: "2026-05-03", status: "active", planKey: "scale", addons: ["addon.cod"] }] },
    { tenantId: "b", periods: [{ from: "2026-02-01", status: "trial", planKey: "starter", addons: [] }, { from: "2026-02-15", status: "active", planKey: "starter", addons: [] }, { from: "2026-04-08", status: "past_due", planKey: "starter", addons: [] }, { from: "2026-04-30", status: "suspended", planKey: "starter", addons: [] }, { from: "2026-06-02", status: "churned", planKey: "starter", addons: [] }] },
    { tenantId: "c", periods: [{ from: "2026-03-20", status: "trial", planKey: "scale", addons: ["addon.customer_campaigns"] }] },
    { tenantId: "e", periods: [{ from: "2025-12-01", status: "active", planKey: "growth", addons: ["addon.customer_campaigns", "addon.cod"] }, { from: "2026-03-31", status: "churned", planKey: "growth", addons: ["addon.customer_campaigns", "addon.cod"] }, { from: "2026-05-15", status: "active", planKey: "growth", addons: [] }] },
  ];
  const events: LifecycleSnapshot[] = subs.flatMap((s) => s.periods.map((p) => ({ tenantId: s.tenantId, at: d(p.from), status: p.status, planKey: p.planKey, addons: p.addons })));
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  const series = platformSeries(events, months);

  /** The subscriptions as they stood at the end of a month: the input `mrr()` reads for "now". */
  function activeSubscriptionsAt(end: Date) {
    return subs.flatMap((s) => {
      const p = [...s.periods].reverse().find((x) => d(x.from) < end);
      return p ? [{ status: subscriptionStatusFor(p.status), planKey: p.planKey, addons: p.addons }] : [];
    });
  }

  it("MRR of every month equals the sum of the subscriptions active at its end", () => {
    for (const point of series) {
      const [y, m] = point.month.split("-").map(Number) as [number, number];
      expect(point.mrrMinor, point.month).toBe(mrr(activeSubscriptionsAt(new Date(Date.UTC(y, m, 1)))));
    }
  });

  it("matches the hand count", () => {
    const growthAll = PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor! + MODULES["addon.customer_campaigns"].monthlyPriceMinor!;
    const growthCod = PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!;
    const by = Object.fromEntries(series.map((p) => [p.month, p]));
    // January: e (growth + both add-ons) and a (converted on the 24th)
    expect(by["2026-01"]!.mrrMinor).toBe(growthAll + growthCod);
    // February: + b on starter
    expect(by["2026-02"]!.mrrMinor).toBe(growthAll + growthCod + PLANS.starter.monthlyPriceMinor);
    // March: e churned on the 31st; c is in trial (0)
    expect(by["2026-03"]!.mrrMinor).toBe(growthCod + PLANS.starter.monthlyPriceMinor);
    expect(by["2026-03"]!.churned).toEqual(["e"]);
    expect(by["2026-03"]!.trial).toEqual(["c"]);
    // April: b past due on the 8th, suspended on the 30th → out of MRR at month end
    expect(by["2026-04"]!.mrrMinor).toBe(growthCod);
    expect(by["2026-04"]!.active).toEqual(["a"]);
    // May: a upgraded to scale, e won back without add-ons
    expect(by["2026-05"]!.mrrMinor).toBe(monthlyChargeMinor("scale", ["addon.cod"]) + PLANS.growth.monthlyPriceMinor);
    expect(by["2026-06"]!.churned).toEqual(["b"]);
    expect(by["2026-01"]!.new.sort()).toEqual(["a"]);
    expect(by["2026-02"]!.new).toEqual(["b"]);
    expect(by["2026-02"]!.addons["addon.cod"]!.sort()).toEqual(["a", "e"]);
    expect(by["2026-04"]!.addons["addon.cod"]).toEqual(["a"]);
    expect(by["2026-03"]!.addons["addon.customer_campaigns"]).toEqual(["c"]);
    expect(Object.values(by["2026-05"]!.mrrByTenant).reduce((s, v) => s + v, 0)).toBe(by["2026-05"]!.mrrMinor);
  });

  it("lists the last months oldest first", () => {
    expect(lastMonths(new Date("2026-03-15T00:00:00Z"), 4)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03"]);
  });
});

describe("tenant health", () => {
  it("is 100 for a healthy tenant", () => {
    expect(tenantHealth({ integrationErrors: 0, failedJobs: 0, daysOverdue: 0, daysSinceLastLogin: 1 })).toEqual({ score: 100, needsAttention: false, factors: [] });
  });
  it("adds up the factors and flags the tenant below the threshold", () => {
    const h = tenantHealth({ integrationErrors: 1, failedJobs: 2, daysOverdue: 3, daysSinceLastLogin: 20 });
    expect(h.factors.map((f) => f.key)).toEqual(["integrations", "invoices", "jobs", "login"]);
    expect(h.score).toBe(100 - 20 - 18 - 10 - 10);
    expect(h.needsAttention).toBe(true);
    expect(tenantHealth({ integrationErrors: 0, failedJobs: 1, daysOverdue: 0, daysSinceLastLogin: 16 }).needsAttention).toBe(false);
  });
  it("caps each factor and never goes below zero", () => {
    expect(tenantHealth({ integrationErrors: 9, failedJobs: 99, daysOverdue: 200, daysSinceLastLogin: null }).score).toBe(0);
  });
});
