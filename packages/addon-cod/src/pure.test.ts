import { describe, expect, it } from "vitest";
import { hoursFor, nextOperator } from "./assignment";
import { applyOutcome, compareQueue } from "./queue";
import { buildRecipientProfile, classifyRecipient, recipientKey } from "./risk";
import { addressQuality, computeDeliveryScore, customerDeliveryScore, penalizedScore, type ScoreInput } from "./scoring";
import { parseCodSettings } from "./settings";

const settings = parseCodSettings({});
const base: ScoreInput = { customerOrders: null, prepaidDelivered: 0, attempts: 0, hoursSinceOrder: 2, closed: false, lines: [{ productId: "p1", variantId: "v1", quantity: 1 }], address: { phone: "+393331234567", address1: "Via Roma 10", zip: "20121", city: "Milano", province: "MI", country: "IT" }, similarOrders: { sample: 40, delivered: 34 }, totalMinor: 8000, aovMinor: 7000, localHour: 14, recentCancellations: { count: 0, sharesProduct: false }, duplicates: "none", riskTier: null };

describe("delivery score", () => {
  it("explains every factor and weights them", () => {
    const r = computeDeliveryScore(base, settings);
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.factors.find((f) => f.key === "customer_history")!.contributes).toBe(false);
    expect(r.factors.find((f) => f.key === "address_quality")).toMatchObject({ raw: 85, severity: "positive", contributes: true });
    expect(r.factors.find((f) => f.key === "similar_orders")!.raw).toBe(85);
    expect(r.factors.find((f) => f.key === "duplicate_orders")!.raw).toBe(100);
  });
  it("drops with bad address, duplicates, attempts and cancellations", () => {
    const r = computeDeliveryScore({ ...base, address: { ...base.address!, phone: "123", zip: "2012" }, duplicates: "same_variant", attempts: 3, recentCancellations: { count: 2, sharesProduct: true } }, settings);
    expect(r.score).toBeLessThan(45);
    const addr = r.factors.find((f) => f.key === "address_quality")!;
    expect(addr.severity).toBe("critical");
    expect(addr.detail.problems).toEqual(expect.arrayContaining(["phone", "zip_format"]));
    expect(r.factors.find((f) => f.key === "cod_attempts")!.raw).toBe(20);
    expect(r.factors.find((f) => f.key === "recent_cancellations")!.raw).toBe(15);
  });
  it("uses customer history with decay and applies the risk penalty last", () => {
    const now = 0;
    void now;
    expect(customerDeliveryScore([{ outcome: "delivered", ageDays: 10 }, { outcome: "refused", ageDays: 400 }], settings)).toBeGreaterThan(70);
    expect(customerDeliveryScore([{ outcome: "delivered", ageDays: 10 }], settings)).toBeNull();
    const good = computeDeliveryScore({ ...base, customerOrders: [{ outcome: "delivered", ageDays: 5 }, { outcome: "delivered", ageDays: 50 }, { outcome: "delivered", ageDays: 90 }] }, settings);
    expect(good.score).toBeGreaterThan(85);
    const risky = computeDeliveryScore({ ...base, riskTier: "blacklisted" }, settings);
    expect(risky.score).toBeLessThanOrEqual(10);
    expect(risky.base).toBeGreaterThan(risky.score);
    expect(penalizedScore(80, "watch", settings)).toBe(60);
    expect(penalizedScore(80, "high_risk", settings)).toBe(36);
  });
  it("respects weights: a zero weight removes a factor from the mean", () => {
    const s = parseCodSettings({ weights: { address_quality: 0 } });
    const r = computeDeliveryScore({ ...base, address: { ...base.address!, phone: null, address1: null } }, s);
    expect(r.factors.find((f) => f.key === "address_quality")!.contributes).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(75);
  });
  it("validates addresses per country", () => {
    expect(addressQuality({ phone: "+14155550123", address1: "1 Market St", zip: "94105", city: "San Francisco", province: null, country: "US" }).ok).toBe(true);
    expect(addressQuality({ phone: "+393331234567", address1: "Via Roma 10", zip: "20121", city: "Milano", province: null, country: "IT" }).problems).toEqual(["province"]);
  });
});

describe("assignment", () => {
  it("distributes in proportion to hours with smooth round-robin", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 40; i++) {
      const u = nextOperator([{ userId: "a", hoursToday: 8, assignedToday: counts.a! }, { userId: "b", hoursToday: 4, assignedToday: counts.b! }, { userId: "c", hoursToday: 0, assignedToday: counts.c! }])!;
      counts[u]!++;
    }
    expect(counts).toEqual({ a: 27, b: 13, c: 0 });
    expect(nextOperator([{ userId: "x", hoursToday: 0, assignedToday: 0 }])).toBeNull();
    expect(hoursFor([0, 8, 8, 8, 8, 8, 0], 1, { kind: "off", hours: null })).toBe(0);
    expect(hoursFor([0, 8, 8, 8, 8, 8, 0], 0, { kind: "extra", hours: 5 })).toBe(5);
    expect(hoursFor([0, 8, 8, 8, 8, 8, 0], 3, null)).toBe(8);
  });
});

describe("queue machine and priority", () => {
  it("applies outcomes", () => {
    expect(applyOutcome({ status: "pending", noAnswerCount: 0 }, "no_answer", settings)).toMatchObject({ status: "pending", noAnswerCount: 1 });
    expect(applyOutcome({ status: "pending", noAnswerCount: 2 }, "no_answer", settings)).toMatchObject({ status: "unreachable", noAnswerCount: 3 });
    const cb = new Date("2026-10-02T09:00:00Z");
    expect(applyOutcome({ status: "pending", noAnswerCount: 1 }, "call_back", settings, cb)).toMatchObject({ status: "scheduled", callBackAt: cb });
    expect(applyOutcome({ status: "scheduled", noAnswerCount: 1 }, "confirmed", settings).status).toBe("confirmed");
  });
  it("orders overdue call-backs first, then attempted, then FIFO, future call-backs last", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const d = (h: number) => new Date(now.getTime() + h * 3600e3);
    const items = [
      { id: "fifo", status: "pending" as const, callBackAt: null, attemptsCount: 0, enteredAt: d(-5) },
      { id: "future", status: "scheduled" as const, callBackAt: d(3), attemptsCount: 1, enteredAt: d(-9) },
      { id: "attempted", status: "pending" as const, callBackAt: null, attemptsCount: 2, enteredAt: d(-2) },
      { id: "overdue", status: "scheduled" as const, callBackAt: d(-1), attemptsCount: 1, enteredAt: d(-8) },
    ];
    expect(items.sort((a, b) => compareQueue(a, b, now)).map((i) => i.id)).toEqual(["overdue", "attempted", "fifo", "future"]);
  });
});

describe("recipient risk", () => {
  it("keys on phone then email, weights returns by age and redeems after consecutive deliveries", () => {
    expect(recipientKey("+393331234567", "a@b.c")).toBe("+393331234567");
    expect(recipientKey(null, "a@b.c")).toBe("email:a@b.c");
    const now = new Date("2026-10-01T00:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * 864e5);
    const p = buildRecipientProfile([{ outcome: "returned", at: ago(500) }, { outcome: "returned", at: ago(40) }, { outcome: "delivered", at: ago(30) }], settings, now);
    expect(p).toMatchObject({ ordersTotal: 3, ordersReturned: 2, weightedReturns: 1, consecutiveDeliveries: 1 });
    expect(classifyRecipient(p, settings).tier).toBe("watch");
    const redeemed = buildRecipientProfile([{ outcome: "returned", at: ago(100) }, { outcome: "delivered", at: ago(60) }, { outcome: "delivered", at: ago(40) }, { outcome: "delivered", at: ago(20) }], settings, now);
    expect(classifyRecipient(redeemed, settings)).toEqual({ tier: "clean", redeemed: true });
    const bad = buildRecipientProfile([{ outcome: "returned", at: ago(10) }, { outcome: "returned", at: ago(20) }, { outcome: "returned", at: ago(30) }], settings, now);
    expect(classifyRecipient(bad, settings).tier).toBe("blacklisted");
    expect(classifyRecipient(bad, settings, "force_clean").tier).toBe("clean");
  });
});
