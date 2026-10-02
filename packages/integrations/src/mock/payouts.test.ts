import { describe, expect, it } from "vitest";
import { payoutTotals } from "@hullwise/core";
import { MockCommercePlatform } from "./commerce";
import { buildMockPayouts, isProcessorGateway } from "./payouts";

const now = new Date("2026-09-30T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 864e5);
const orders = [
  { externalId: "1001", placedAt: day(10), totalMinor: 10000, refundedMinor: 0, gateways: ["shopify_payments"] },
  { externalId: "1002", placedAt: day(10), totalMinor: 5000, refundedMinor: 1000, gateways: ["apple_pay"] },
  { externalId: "1003", placedAt: day(9), totalMinor: 7000, refundedMinor: 0, gateways: ["paypal"] },
  { externalId: "1004", placedAt: day(0.1), totalMinor: 3000, refundedMinor: 0, gateways: ["shopify_payments"] },
];

describe("mock payouts", () => {
  it("only processor gateways are paid out", () => {
    expect(isProcessorGateway(["shopify_payments"])).toBe(true);
    expect(isProcessorGateway(["Shop_Pay"])).toBe(true);
    expect(isProcessorGateway(["paypal", "manual"])).toBe(false);
  });
  it("builds deterministic deposits whose totals add up from their transactions", () => {
    const a = buildMockPayouts({ orders, currency: "EUR", now });
    const b = buildMockPayouts({ orders: [...orders].reverse(), currency: "EUR", now });
    expect(a).toEqual(b);
    expect(a.transactions.some((t) => t.orderExternalId === "1003")).toBe(false);
    const charges = a.transactions.filter((t) => t.type === "charge");
    expect(charges.map((t) => t.orderExternalId).sort()).toEqual(["1001", "1002", "1004"]);
    // fees are the processor's own (domestic 1.5 % + 0.25 or international 2.9 % + 0.25 in EUR), not Hullwise's estimate
    for (const c of charges) expect([Math.round(c.amountMinor * 0.015) + 25, Math.round(c.amountMinor * 0.029) + 25]).toContain(c.feeMinor);
    expect(a.transactions.find((t) => t.type === "refund")).toMatchObject({ orderExternalId: "1002", amountMinor: -1000, feeMinor: 0 });
    for (const p of a.payouts) {
      const t = payoutTotals(a.transactions.filter((x) => x.payoutExternalId === p.externalId));
      expect([p.grossMinor, p.refundsMinor, p.adjustmentsMinor, p.feeMinor, p.netMinor]).toEqual([t.grossMinor, t.refundsMinor, t.adjustmentsMinor, t.feesMinor, t.netMinor]);
    }
    // the charge of today's order is paid out in two days: a scheduled deposit
    const recent = a.transactions.find((t) => t.orderExternalId === "1004")!;
    expect(a.payouts.find((p) => p.externalId === recent.payoutExternalId)!.status).toBe("scheduled");
    expect(a.payouts.at(-1)!.status).toBe("paid");
    expect(buildMockPayouts({ orders, currency: "EUR", now, since: day(1) }).payouts.every((p) => p.issuedAt >= day(1))).toBe(true);
  });
  it("the mock adapter pages payouts and transactions and adds the refunds it made", async () => {
    const p = new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "T-", startOrderNumber: 1, locations: [], customers: [], variants: [], paymentOrders: orders.map((o) => ({ ...o, placedAt: new Date(Date.now() - (now.getTime() - o.placedAt.getTime())) })) });
    const first = await p.fetchPayouts({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    const all = await p.fetchPayouts({ limit: 50 });
    const txns = (await Promise.all(all.items.map((x) => p.fetchBalanceTransactions({ payoutExternalId: x.externalId })))).flatMap((x) => x.items);
    expect(txns.filter((t) => t.type === "charge")).toHaveLength(3);
    const r = await p.refundOrder("1001", { lines: [], amountMinor: 1000, currency: "EUR", notify: false });
    expect(r.amountMinor).toBe(1000);
    const after = await p.fetchPayouts({ limit: 50 });
    const txns2 = (await Promise.all(after.items.map((x) => p.fetchBalanceTransactions({ payoutExternalId: x.externalId })))).flatMap((x) => x.items);
    expect(txns2.filter((t) => t.type === "refund" && t.orderExternalId === "1001").map((t) => t.amountMinor)).toEqual([-1000]);
    expect(p.writeLog.at(-1)).toMatchObject({ op: "refundOrder" });
  });
  it("caps a refund at what is left on an order it knows and marks it paid", async () => {
    const p = new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "T-", startOrderNumber: 1, locations: [{ externalId: "loc-1", name: "Main", country: "IT", isDefault: true, isActive: true }], customers: [{ externalId: "c1", email: null, phone: null, firstName: "A", lastName: "B", country: "IT", city: null, zip: null, acceptsMarketing: false, tags: [], platformCreatedAt: null }], variants: [{ externalId: "v1", productExternalId: "p1", inventoryItemExternalId: "i1", sku: "S", title: "M", productTitle: "Tee", optionValues: {}, priceMinor: 5000 }], inventory: [{ inventoryItemExternalId: "i1", locationExternalId: "loc-1", available: 10 }] });
    const o = await p.createOrder({ lines: [{ variantExternalId: "v1", sku: null, title: "Tee", quantity: 1, unitPriceMinor: 5000 }], currency: "EUR", email: null, phone: null, customerExternalId: null, shippingAddress: null, billingAddress: null, shippingMinor: 0, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: null, payment: { method: "card", status: "paid", gateways: ["shopify_payments"] } });
    expect(p.stockOf("i1", "loc-1")).toBe(9);
    const r1 = await p.refundOrder(o.externalId, { lines: [{ orderLineExternalId: o.lines[0]!.externalId, quantity: 1, restock: true }], amountMinor: 4000, currency: "EUR", notify: false });
    expect(r1.amountMinor).toBe(4000);
    expect(p.stockOf("i1", "loc-1")).toBe(10);
    const r2 = await p.refundOrder(o.externalId, { lines: [], amountMinor: 4000, currency: "EUR", notify: false });
    expect(r2.amountMinor).toBe(1000);
    expect((await p.fetchOrder(o.externalId))!.paymentStatus).toBe("refunded");
    const pending = await p.createOrder({ lines: [{ variantExternalId: "v1", sku: null, title: "Tee", quantity: 1, unitPriceMinor: 5000 }], currency: "EUR", email: null, phone: null, customerExternalId: null, shippingAddress: null, billingAddress: null, shippingMinor: 0, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: null, payment: { method: "bank_transfer", status: "pending", gateways: ["bank_deposit"] } });
    await p.markOrderPaid(pending.externalId, { amountMinor: 5000, currency: "EUR", method: "bank_transfer", fullBalance: true });
    expect((await p.fetchOrder(pending.externalId))!.paymentStatus).toBe("paid");
  });
});
