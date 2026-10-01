import { describe, expect, it } from "vitest";
import { addMonths, monthlyInvoiceLines, mrr, paymentHealth, setupInvoiceLines, sumLines } from "./billing";

describe("billing", () => {
  it("prices plan plus priced add-ons only", () => {
    const lines = monthlyInvoiceLines("growth", ["addon.cod", "addon.whatsapp"]);
    expect(lines).toEqual([{ kind: "plan", key: "growth", amountMinor: 34900 }, { kind: "addon", key: "addon.cod", amountMinor: 9900 }]);
    expect(sumLines(lines)).toBe(44800);
    expect(setupInvoiceLines("starter")[0]!.amountMinor).toBe(49000);
  });
  it("derives payment health from open invoices and the grace period", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(paymentHealth([], now, 14).health).toBe("none");
    expect(paymentHealth([{ status: "paid", dueAt: new Date("2026-09-01") }], now, 14).health).toBe("ok");
    expect(paymentHealth([{ status: "open", dueAt: new Date("2026-09-25") }], now, 14)).toEqual({ health: "past_due", daysOverdue: 6 });
    expect(paymentHealth([{ status: "open", dueAt: new Date("2026-09-01") }], now, 14).health).toBe("suspended");
  });
  it("computes mrr and month arithmetic", () => {
    expect(mrr([{ status: "active", planKey: "starter", addons: [] }, { status: "trialing", planKey: "scale", addons: [] }, { status: "past_due", planKey: "growth", addons: ["addon.cod"] }])).toBe(14900 + 44800);
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-03-03");
  });
});
