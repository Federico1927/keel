import { describe, expect, it } from "vitest";
import { MODULES, PLANS } from "@hullwise/config";
import { paymentHealth } from "./billing";
import { billingCatalog, catalogChange, mergeInvoiceStatus, catalogItemFor, desiredSubscriptionKeys, isCatalogUnchanged, lookupKeyFor, mirroredMrr, stripeKeyMode, subscriptionItemChanges, subscriptionSignal, vatTreatment } from "./subscription-billing";

describe("billing catalog", () => {
  it("lists every plan (monthly), its setup fee (one-off) and the priced, implemented add-ons", () => {
    const c = billingCatalog();
    expect(c.filter((i) => i.kind === "plan").map((i) => i.lookupKey)).toEqual(["hullwise_plan_starter_monthly", "hullwise_plan_growth_monthly", "hullwise_plan_scale_monthly"]);
    expect(catalogItemFor("hullwise_setup_growth", c)).toMatchObject({ kind: "setup", amountMinor: PLANS.growth.setupFeeMinor, interval: null, productId: "hullwise_setup_growth" });
    expect(catalogItemFor("hullwise_addon_cod_monthly", c)).toMatchObject({ kind: "addon", key: "addon.cod", amountMinor: MODULES["addon.cod"].monthlyPriceMinor, interval: "month", name: "Hullwise add-on: Cash on delivery" });
    // on-request add-ons have no price: not in the catalog
    expect(c.some((i) => i.key === "addon.whatsapp")).toBe(false);
    expect(new Set(c.map((i) => i.lookupKey)).size).toBe(c.length);
  });

  it("creates what is missing, a new price when the amount changes, nothing when in step", () => {
    const item = catalogItemFor("hullwise_plan_growth_monthly")!;
    expect(catalogChange(item, { product: null, price: null })).toEqual({ createProduct: true, updateProduct: false, createPrice: true, archivePriceId: null });
    const current = { product: { name: item.name, active: true }, price: { id: "price_1", productId: item.productId, amountMinor: item.amountMinor, currency: "usd", interval: "month" as const } };
    expect(isCatalogUnchanged(catalogChange(item, current))).toBe(true);
    expect(catalogChange(item, { ...current, price: { ...current.price, amountMinor: 1 } })).toEqual({ createProduct: false, updateProduct: false, createPrice: true, archivePriceId: "price_1" });
    expect(catalogChange(item, { ...current, product: { name: "Old", active: false } })).toMatchObject({ updateProduct: true, createPrice: false });
  });
});

describe("subscriptions", () => {
  it("reads the key mode from the prefix", () => {
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode("pk_test_abc")).toBeNull();
    expect(stripeKeyMode("")).toBeNull();
    expect(stripeKeyMode(undefined)).toBeNull();
  });

  it("maps Stripe statuses onto lifecycle signals", () => {
    expect(["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].map(subscriptionSignal)).toEqual(["trial", "active", "past_due", "past_due", "cancelled", "pending", "cancelled", "inactive"]);
  });

  it("computes item changes: plan swap keeps the item, add-ons are added and removed", () => {
    expect(desiredSubscriptionKeys("growth", ["addon.whatsapp", "addon.cod"])).toEqual(["hullwise_plan_growth_monthly", "hullwise_addon_cod_monthly"]);
    const current = [{ itemId: "si_plan", lookupKey: lookupKeyFor("plan", "starter") }, { itemId: "si_cod", lookupKey: "hullwise_addon_cod_monthly" }];
    expect(subscriptionItemChanges(current, ["hullwise_plan_growth_monthly", "hullwise_addon_customer_campaigns_monthly"])).toEqual({ add: ["hullwise_addon_customer_campaigns_monthly"], remove: ["si_cod"], swap: [{ itemId: "si_plan", lookupKey: "hullwise_plan_growth_monthly" }] });
    expect(subscriptionItemChanges(current, ["hullwise_plan_starter_monthly", "hullwise_addon_cod_monthly"])).toEqual({ add: [], remove: [], swap: [] });
  });

  it("MRR counts recurring items of active and past-due subscriptions only", () => {
    const items = [{ unitAmountMinor: 59900, quantity: 1, interval: "month" }, { unitAmountMinor: 150000, quantity: 1, interval: null }];
    expect(mirroredMrr([{ externalStatus: "active", items }, { externalStatus: "trialing", items }, { externalStatus: "past_due", items: [items[0]!] }, { externalStatus: "canceled", items }])).toBe(59900 * 2);
  });

  it("VAT: reverse charge for verified EU business customers abroad, never a default seller country", () => {
    expect(vatTreatment({ sellerCountry: "IT", customerCountry: "DE", vatIdVerified: true })).toBe("reverse_charge");
    expect(vatTreatment({ sellerCountry: "IT", customerCountry: "DE", vatIdVerified: false })).toBe("eu_b2c");
    expect(vatTreatment({ sellerCountry: "IT", customerCountry: "IT", vatIdVerified: true })).toBe("domestic");
    expect(vatTreatment({ sellerCountry: "IT", customerCountry: "US", vatIdVerified: false })).toBe("export");
    expect(vatTreatment({ sellerCountry: "IT", customerCountry: "EL", vatIdVerified: true })).toBe("reverse_charge");
    expect(vatTreatment({ sellerCountry: null, customerCountry: "DE", vatIdVerified: true })).toBe("unknown");
  });
});

describe("invoice status from out-of-order events", () => {
  it("never moves an invoice back", () => {
    expect(mergeInvoiceStatus(null, "open")).toBe("open");
    expect(mergeInvoiceStatus("open", "paid")).toBe("paid");
    expect(mergeInvoiceStatus("paid", "open")).toBe("paid");
    expect(mergeInvoiceStatus("uncollectible", "open")).toBe("uncollectible");
    expect(mergeInvoiceStatus("uncollectible", "paid")).toBe("paid");
    expect(mergeInvoiceStatus("void", "paid")).toBe("void");
  });
});

describe("payment health with Stripe signals", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  it("a failed charge makes the tenant past due at once; suspended beyond the grace period", () => {
    expect(paymentHealth([{ status: "open", dueAt: now, paymentFailedAt: now }], now, 14)).toEqual({ health: "past_due", daysOverdue: 0 });
    expect(paymentHealth([{ status: "open", dueAt: new Date("2026-09-10"), paymentFailedAt: new Date("2026-09-10") }], now, 14).health).toBe("suspended");
    expect(paymentHealth([{ status: "uncollectible", dueAt: now }], now, 14).health).toBe("past_due");
    expect(paymentHealth([{ status: "open", dueAt: now }], now, 14).health).toBe("ok");
  });
});
