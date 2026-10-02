import { describe, expect, it } from "vitest";
import { applyDiscountToAmounts, isOrderEditable, isReplacedOrder, linesDiffer, mergeBlock, mergeLines, orderDiscountAmount, orderDiscountCode, orderEditBlock, replacementBalance, type MergeFacts } from "./order-edit";
import { validateAddressFormat, normalizeAddress } from "./address";
import { deriveOrderStatus } from "./state-rules";

const open = { status: "confirmed", cancelledAt: null, replacedByOrderId: null, fulfillmentStatusRaw: null, shipmentCount: 0 };

describe("orderEditBlock", () => {
  it("allows any open, unfulfilled order regardless of payment method", () => {
    expect(orderEditBlock(open)).toBeNull();
    expect(isOrderEditable({ ...open, status: "new", fulfillmentStatusRaw: "unfulfilled" })).toBe(true);
    expect(isOrderEditable({ ...open, status: "on_hold" })).toBe(true);
    expect(isOrderEditable({ ...open, status: "pending_review" })).toBe(true);
  });
  it("blocks cancelled, replaced, fulfilled and closed orders", () => {
    expect(orderEditBlock({ ...open, cancelledAt: new Date() })).toBe("cancelled");
    expect(orderEditBlock({ ...open, replacedByOrderId: "x", cancelledAt: new Date() })).toBe("replaced");
    expect(orderEditBlock({ ...open, shipmentCount: 1 })).toBe("fulfilled");
    expect(orderEditBlock({ ...open, fulfillmentStatusRaw: "partial" })).toBe("fulfilled");
    expect(orderEditBlock({ ...open, status: "fulfilling" })).toBe("closed");
    expect(orderEditBlock({ ...open, status: "delivered" })).toBe("closed");
  });
  it("flags replaced orders as lineage", () => {
    expect(isReplacedOrder({ replacedByOrderId: "x" })).toBe(true);
    expect(isReplacedOrder({ replacedByOrderId: null })).toBe(false);
  });
});

describe("order discount", () => {
  const order = { subtotalMinor: 10_000, discountMinor: 1_000, shippingMinor: 500, totalMinor: 9_500 };
  it("percentage applies to the items still due, shipping excluded", () => {
    expect(orderDiscountAmount(order, { type: "percentage", value: 1000 })).toBe(900);
    expect(orderDiscountAmount(order, { type: "percentage", value: 15_000 })).toBe(9_000);
  });
  it("fixed amount is capped at the items still due", () => {
    expect(orderDiscountAmount(order, { type: "fixed_amount", value: 250 })).toBe(250);
    expect(orderDiscountAmount(order, { type: "fixed_amount", value: 50_000 })).toBe(9_000);
    expect(orderDiscountAmount(order, { type: "fixed_amount", value: 0 })).toBe(0);
  });
  it("updates totals and builds a readable code", () => {
    expect(applyDiscountToAmounts(order, 900)).toEqual({ subtotalMinor: 10_000, discountMinor: 1_900, shippingMinor: 500, totalMinor: 8_600 });
    expect(orderDiscountCode({ type: "percentage", value: 1000 })).toBe("HULLWISE-10%");
    expect(orderDiscountCode({ type: "fixed_amount", value: 550 })).toBe("HULLWISE-5.50");
    expect(orderDiscountCode({ type: "fixed_amount", value: 550 }, " SORRY5 ")).toBe("SORRY5");
  });
});

describe("replacement lines and merges", () => {
  const l = (variantId: string, quantity: number, unitPriceMinor = 1000) => ({ variantId, quantity, unitPriceMinor, title: variantId, sku: null });
  it("detects line changes by variant and quantity, ignoring order and zero lines", () => {
    expect(linesDiffer([l("a", 1), l("b", 2)], [l("b", 2), l("a", 1), l("c", 0)])).toBe(false);
    expect(linesDiffer([l("a", 1)], [l("a", 2)])).toBe(true);
  });
  it("folds the same variant at the same price, keeps the rest", () => {
    const out = mergeLines([l("a", 1), l("b", 0)], [l("a", 2), l("a", 1, 900), l("c", 1)]);
    expect(out.map((x) => [x.variantId, x.quantity, x.unitPriceMinor])).toEqual([["a", 3, 1000], ["a", 1, 900], ["c", 1, 1000]]);
  });
  const facts = (over: Partial<MergeFacts>): MergeFacts => ({ ...open, id: "t", customerId: "c1", emailNormalized: "a@b.c", phoneE164: null, currency: "USD", paymentMethod: "card", paymentStatus: "paid", ...over });
  it("merges only editable orders of the same person with the same payment state", () => {
    const target = facts({});
    expect(mergeBlock(target, facts({ id: "o" }))).toBeNull();
    expect(mergeBlock(target, facts({ id: "o", customerId: null }))).toBeNull();
    expect(mergeBlock(target, facts({ id: "t" }))).toBe("same_order");
    expect(mergeBlock(target, facts({ id: "o", customerId: "c2", emailNormalized: "x@y.z" }))).toBe("other_customer");
    expect(mergeBlock(target, facts({ id: "o", paymentMethod: "cod", paymentStatus: "pending" }))).toBe("payment");
    expect(mergeBlock(target, facts({ id: "o", currency: "EUR" }))).toBe("currency");
    expect(mergeBlock(target, facts({ id: "o", shipmentCount: 1 }))).toBe("not_editable");
  });
  it("computes the balance to settle on paid replacements only", () => {
    expect(replacementBalance(true, 5000, 6500)).toBe(1500);
    expect(replacementBalance(true, 5000, 4000)).toBe(-1000);
    expect(replacementBalance(false, 5000, 6500)).toBe(0);
  });
  it("a replaced order is a final cancelled state, even if the platform still has it open", () => {
    const input = { platformTags: [], paymentMethod: "card" as const, paymentStatus: "paid" as const, financialStatusRaw: "paid", fulfillmentStatusRaw: null, cancelledAt: null, placedAt: new Date(), manualStatus: "confirmed" as const };
    expect(deriveOrderStatus({ ...input, replacedByOrderId: "new" }, [])).toEqual({ status: "cancelled", reason: "override:replaced" });
    expect(deriveOrderStatus(input, []).status).toBe("confirmed");
  });
});

describe("address format", () => {
  it("requires the core fields and checks postal codes per country", () => {
    expect(validateAddressFormat({ name: "Ann Lee", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", country: "US" })).toEqual([]);
    expect(validateAddressFormat({ name: "Ann Lee", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701-1234", country: "us" })).toEqual([]);
    expect(validateAddressFormat({ name: "Mario Rossi", address1: "Via Roma 1", city: "Milano", zip: "2010", country: "IT" })).toEqual([{ field: "zip", code: "invalid_zip" }]);
    expect(validateAddressFormat({ name: "A", address1: "B", city: "C", zip: "1012 ab", country: "NL" })).toEqual([]);
    expect(validateAddressFormat({ address1: "", country: "USA" }).map((i) => `${i.field}:${i.code}`)).toEqual(["name:required", "address1:required", "city:required", "country:invalid_country", "zip:required"]);
    expect(validateAddressFormat({ name: "A", address1: "B", city: "C", zip: "78701", country: "US" })).toEqual([{ field: "province", code: "required" }]);
    // unknown pattern: required fields only
    expect(validateAddressFormat({ name: "A", address1: "B", city: "C", zip: "anything", country: "BR" })).toEqual([]);
  });
  it("normalizes whitespace, case and empty strings", () => {
    expect(normalizeAddress({ name: " Ann  Lee ", address1: "1 Main St", address2: " ", city: "Austin", province: "TX", zip: " 78701 ", country: "us" })).toEqual({ name: "Ann Lee", address1: "1 Main St", address2: null, city: "Austin", province: "TX", zip: "78701", country: "US", phone: null });
  });
});
