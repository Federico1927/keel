import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockConversionSink, type MockCommercePlatform, type NormalizedOrder } from "@hullwise/integrations";
import { applyCancellation, enqueueConversions, getCommercePlatformFor, importOrder, queueConversionAdjustments, recheckConversionAdjustments, refundOrder, resetMockPlatforms, saveConversionSettings, sendDueConversions, type ServiceContext } from "../src";

/** Retractions and restatements of server-side conversions (#82). */
const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
const sinks = { meta: new MockConversionSink("meta"), google: new MockConversionSink("google") };
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  resetMockPlatforms();
  tenantId = ctx.tenantIds.northwind;
  // the simulated store numbers its orders after the highest one it saw when built: build it before this file's orders
  const t = (await run((s) => s.tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))))[0]!;
  await run((s) => getCommercePlatformFor(s, t));
  await run((s) => saveConversionSettings(s, { provider: "meta", enabled: true, destinationId: "123", testEventCode: null, requireConsent: false, lookbackDays: 7 }));
  await run((s) => saveConversionSettings(s, { provider: "google", enabled: true, destinationId: "777", testEventCode: null, requireConsent: false, lookbackDays: 30 }));
  // start from a clean log: only this file's orders
  await run((s) => s.tx.delete(schema.conversionEvents).where(eq(schema.conversionEvents.tenantId, tenantId)));
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const send = () => run((s) => sendDueConversions(s, (p) => sinks[p]));
const rowsOf = (orderId: string) => run((s) => s.tx.select().from(schema.conversionEvents).where(and(eq(schema.conversionEvents.tenantId, tenantId), eq(schema.conversionEvents.orderId, orderId))).orderBy(schema.conversionEvents.provider, schema.conversionEvents.kind));

let seq = 0;
/** A paid sale order with an email and a Google click, whose purchase reached both platforms. */
async function soldOrder(totalMinor = 15000): Promise<string> {
  seq++;
  const id = await run(async (s) => {
    const email = `adjust.${seq}@example.com`;
    const [o] = await s.tx.insert(schema.orders).values({ tenantId, externalId: `adj-${seq}`, orderNumber: 980000 + seq, name: `#ADJ-${seq}`, email, emailNormalized: email, currency: "EUR", shippingCountry: "IT", paymentGateways: ["shopify_payments"], platformTags: [], paymentMethod: "card", paymentStatus: "paid", status: "confirmed", totalMinor, taxMinor: 0, subtotalMinor: totalMinor, placedAt: new Date(Date.now() - 3600_000) }).returning({ id: schema.orders.id });
    await s.tx.insert(schema.orderAttribution).values({ tenantId, orderId: o!.id, clickIds: { gclid: `Cj0K${seq}`, fbclid: `IwAR${seq}` }, channel: "paid_search" });
    return o!.id;
  });
  await run((s) => enqueueConversions(s));
  await send();
  const rows = await rowsOf(id);
  expect(rows.filter((r) => r.kind === "purchase").map((r) => r.status)).toEqual(["sent", "sent"]);
  return id;
}

describe("conversion adjustments", () => {
  it("a cancellation in the app queues one retraction per platform: sent to Google, logged as unsupported for Meta", async () => {
    const orderId = await soldOrder();
    await run((s) => applyCancellation(s, orderId, { reason: "customer", restock: false, refund: true }));
    const rows = await rowsOf(orderId);
    const retractions = rows.filter((r) => r.kind === "retraction");
    expect(retractions.map((r) => [r.provider, r.status, r.reason])).toEqual([["google", "pending", null], ["meta", "skipped", "unsupported"]]);
    expect(retractions.every((r) => r.eventId === "order-adj-1:retraction")).toBe(true);
    const sum = await send();
    expect(sum.find((x) => x.provider === "google")).toMatchObject({ sent: 1, failed: 0 });
    const g = (await rowsOf(orderId)).find((r) => r.provider === "google" && r.kind === "retraction")!;
    expect(g).toMatchObject({ status: "sent", attempts: 1 });
    expect(g.payload).toMatchObject({ kind: "retraction", orderExternalId: "adj-1" });
    const sent = sinks.google.adjusted.find((a) => a.adjustment.orderExternalId === "adj-1")!;
    expect(sent.request).toMatchObject({ adjustmentType: "RETRACTION", orderId: "adj-1", gclidDateTimePair: { gclid: "Cj0K1" } });
  });

  it("a replay changes nothing: same cancellation, the hook again, the safety re-check", async () => {
    // seed orders refunded in part before this file sent their purchases get their restatements first
    await run((s) => recheckConversionAdjustments(s));
    await send();
    const orderId = (await run((s) => s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.externalId, "adj-1")))))[0]!.id;
    const before = await rowsOf(orderId);
    expect(await run((s) => applyCancellation(s, orderId, { reason: "customer", restock: false, refund: true }))).toBeNull();
    expect(await run((s) => queueConversionAdjustments(s, [orderId]))).toEqual({ retractions: 0, restatements: 0, unsupported: 0 });
    await run((s) => recheckConversionAdjustments(s));
    const after = await rowsOf(orderId);
    expect(after.map((r) => [r.id, r.status])).toEqual(before.map((r) => [r.id, r.status]));
    const again = await send();
    expect(again.every((x) => x.sent === 0 && x.failed === 0), JSON.stringify(again)).toBe(true);
  });

  it("a partial refund restates Google to the remaining value and logs Meta's skip; a second refund re-arms it", async () => {
    const orderId = await soldOrder(15000);
    const r = await run((s) => refundOrder(s, undefined, { orderId, amountMinor: 5000, requestId: "adj-partial-1" }));
    expect(r.paymentStatus).toBe("partially_refunded");
    let rows = (await rowsOf(orderId)).filter((x) => x.kind === "restatement");
    expect(rows.map((x) => [x.provider, x.status, x.reason, x.valueMinor])).toEqual([["google", "pending", null, 10000], ["meta", "skipped", "unsupported", 10000]]);
    await send();
    const req = sinks.google.adjusted.find((a) => a.adjustment.orderExternalId === `adj-${seq}`)!.request;
    expect(req).toMatchObject({ adjustmentType: "RESTATEMENT", restatementValue: { adjustedValue: 100, currencyCode: "EUR" } });
    await run((s) => refundOrder(s, undefined, { orderId, amountMinor: 2000, requestId: "adj-partial-2" }));
    rows = (await rowsOf(orderId)).filter((x) => x.kind === "restatement");
    expect(rows.find((x) => x.provider === "google")).toMatchObject({ status: "pending", valueMinor: 8000, attempts: 0 });
    // still one row per order, platform and kind
    expect((await rowsOf(orderId)).filter((x) => x.provider === "google").map((x) => x.kind).sort()).toEqual(["purchase", "restatement"]);
    // refunding the rest withdraws it: the pending restatement is superseded by the retraction
    await run((s) => refundOrder(s, undefined, { orderId, amountMinor: 8000, requestId: "adj-partial-3" }));
    const final = (await rowsOf(orderId)).filter((x) => x.provider === "google");
    expect(final.find((x) => x.kind === "restatement")).toMatchObject({ status: "skipped", reason: "superseded" });
    expect(final.find((x) => x.kind === "retraction")).toMatchObject({ status: "pending" });
  });

  it("a cancellation imported from the platform queues the retraction too", async () => {
    const t = (await run((s) => s.tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))))[0]!;
    const mock = (await run((s) => getCommercePlatformFor(s, t))) as MockCommercePlatform;
    const order: NormalizedOrder = await mock.createOrder({ lines: [{ variantExternalId: null, sku: null, title: "Gift card", quantity: 1, unitPriceMinor: 9000 }], currency: "EUR", email: "imported.adjust@example.com", phone: null, customerExternalId: null, shippingAddress: { name: "Ada Rossi", address1: "Via Roma 1", city: "Milano", province: "MI", zip: "20121", country: "IT" }, billingAddress: null, shippingMinor: 0, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: null, payment: { method: "card", status: "paid", gateways: ["shopify_payments"] } });
    const { id } = await run((s) => importOrder(s, { ...order, landingSite: "/?gclid=CjImported" }, { country: "IT", source: "webhook" }));
    await run((s) => s.tx.update(schema.orders).set({ status: "confirmed" }).where(eq(schema.orders.id, id)));
    await run((s) => enqueueConversions(s));
    await send();
    expect((await rowsOf(id)).filter((r) => r.kind === "purchase" && r.status === "sent")).toHaveLength(2);
    await run((s) => importOrder(s, { ...order, landingSite: "/?gclid=CjImported", cancelledAt: new Date(), cancelReason: "customer", paymentStatus: "voided", financialStatusRaw: "voided", platformUpdatedAt: new Date(Date.now() + 1000) }, { country: "IT", source: "webhook" }));
    expect((await rowsOf(id)).filter((r) => r.kind === "retraction").map((r) => r.provider)).toEqual(["google", "meta"]);
  });

  it("a purchase still queued when the order is cancelled is dropped, with no retraction", async () => {
    seq++;
    const orderId = await run(async (s) => {
      const [o] = await s.tx.insert(schema.orders).values({ tenantId, externalId: `adj-${seq}`, orderNumber: 980000 + seq, name: `#ADJ-${seq}`, email: "queued@example.com", emailNormalized: "queued@example.com", currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], paymentMethod: "card", paymentStatus: "paid", status: "confirmed", totalMinor: 5000, taxMinor: 0, subtotalMinor: 5000, placedAt: new Date(Date.now() - 600_000) }).returning({ id: schema.orders.id });
      return o!.id;
    });
    await run((s) => enqueueConversions(s));
    await run((s) => applyCancellation(s, orderId, { reason: "customer", restock: false, refund: false }));
    await send();
    const rows = await rowsOf(orderId);
    expect(rows.map((r) => [r.kind, r.status, r.reason])).toEqual([["purchase", "skipped", "withdrawn"], ["purchase", "skipped", "withdrawn"]]);
  });

  it("the safety re-check catches a cancellation that bypassed the hooks", async () => {
    const orderId = await soldOrder();
    await run((s) => s.tx.execute(sql`update orders set status = 'cancelled', cancelled_at = now() where id = ${orderId}`));
    expect((await rowsOf(orderId)).some((r) => r.kind === "retraction")).toBe(false);
    const q = await run((s) => recheckConversionAdjustments(s));
    expect(q).toMatchObject({ retractions: 1, unsupported: 1 });
    expect((await rowsOf(orderId)).filter((r) => r.kind === "retraction")).toHaveLength(2);
  });

  it("a failed retraction retries with the same backoff as purchases", async () => {
    const orderId = await soldOrder();
    await run((s) => applyCancellation(s, orderId, { reason: "other", restock: false, refund: false }));
    sinks.google.failures.failNext("rate_limited");
    await send();
    const g = (await rowsOf(orderId)).find((r) => r.provider === "google" && r.kind === "retraction")!;
    expect(g).toMatchObject({ status: "failed", attempts: 1 });
    expect(g.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });
});
