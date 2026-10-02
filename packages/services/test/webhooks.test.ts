import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, schema, sql, withTenant, type Database } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { WEBHOOK_HEADERS } from "@hullwise/config";
import { verifyWebhookSignature, type WebhookUrlPolicy } from "@hullwise/core";
import { MockCommercePlatform } from "@hullwise/integrations";
import { adjustStock, importOrder, createWebhookEndpoint, deliverWebhook, drainWebhookJobs, dueWebhookDeliveries, guardedWebhookSend, listWebhookDeliveries, listWebhookEndpoints, redeliverWebhook, rotateWebhookSecret, sendTestWebhook, setManualStatus, setWebhookDispatcher, updateWebhookEndpoint, validateWebhookUrl, webhookHmac, type ServiceContext } from "../src";

/**
 * Outgoing webhooks (#81) end to end against a local HTTP receiver on loopback (allowed by the test
 * policy only): emitted by the status engine and the stock service inside the change's transaction,
 * delivered with a verifiable signature, retried on the schedule until dead, redelivered by hand,
 * signed with both secrets during a rotation, refused for private targets, isolated per tenant.
 */

const pools = testPools();
let ctx: SeedContext;
let A = "";
let B = "";
const app = pools.app as unknown as Database;
const loopback: WebhookUrlPolicy = { allowLoopback: true };
const strict: WebhookUrlPolicy = { allowLoopback: false };

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let received: Received[] = [];
let answer = 200;
let receiverUrl = "";

const svc = (tenantId: string, tx: ServiceContext["tx"], email = "owner@northwind.demo"): ServiceContext => ({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! } });
const inTenant = <T>(tenantId: string, fn: (c: ServiceContext) => Promise<T>, email?: string) => withTenant(tenantId, (tx) => fn(svc(tenantId, tx, email)), app);

async function endpoint(tenantId: string, eventTypes: string[], url = receiverUrl, email = "owner@northwind.demo") {
  return inTenant(tenantId, (c) => createWebhookEndpoint(c, { url, eventTypes, description: "test receiver" }, { policy: loopback }), email);
}

async function latestDelivery(tenantId: string, eventType: string) {
  const [d] = await pools.admin.select().from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.tenantId, tenantId), eq(schema.webhookDeliveries.eventType, eventType))).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(1);
  return d;
}

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  A = ctx.tenantIds.northwind;
  B = ctx.tenantIds.harbor;
  await pools.admin.update(schema.tenants).set({ planKey: "growth" }).where(eq(schema.tenants.id, B));
  // no dispatcher: deliveries are driven by the tests
  setWebhookDispatcher(null);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(answer, { "Content-Type": "text/plain" });
      res.end(answer === 200 ? "ok" : "boom");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await pools.admin.update(schema.tenants).set({ planKey: "starter" }).where(eq(schema.tenants.id, B));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pools.close();
});
beforeEach(async () => {
  received = [];
  answer = 200;
  drainWebhookJobs();
  await pools.admin.delete(schema.webhookEndpoints);
});

describe("URL guard", () => {
  it("refuses private, link-local and metadata targets, statically and after DNS resolution", async () => {
    await expect(validateWebhookUrl("https://10.0.0.8/hook", { policy: strict })).rejects.toMatchObject({ code: "private_address" });
    await expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data", { policy: strict })).rejects.toMatchObject({ code: "private_address" });
    await expect(validateWebhookUrl("http://hooks.example.com/in", { policy: strict })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(validateWebhookUrl(receiverUrl, { policy: strict })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(validateWebhookUrl("https://rebind.example.com/hook", { policy: strict, resolve: async () => ["93.184.216.34", "169.254.169.254"] })).rejects.toMatchObject({ code: "private_address" });
    await expect(validateWebhookUrl("https://nowhere.example.com/hook", { policy: strict, resolve: async () => null })).rejects.toMatchObject({ code: "unresolvable" });
    expect(await validateWebhookUrl("https://hooks.example.com/in", { policy: strict, resolve: async () => ["93.184.216.34"] })).toBe("https://hooks.example.com/in");
    expect(await validateWebhookUrl(receiverUrl, { policy: loopback })).toBe(receiverUrl);
  });

  it("the sender refuses loopback outside the test policy and never follows redirects", async () => {
    const blocked = await guardedWebhookSend({ url: receiverUrl, headers: {}, body: "{}", policy: strict });
    expect(blocked.status).toBeNull();
    expect(blocked.error).toContain("blocked");
    const viaName = await guardedWebhookSend({ url: receiverUrl.replace("127.0.0.1", "localhost"), headers: {}, body: "{}", policy: strict });
    expect(viaName.error).toContain("blocked");
    expect(received).toHaveLength(0);
    answer = 302;
    const redirect = await guardedWebhookSend({ url: receiverUrl, headers: {}, body: "{}", policy: loopback });
    expect(redirect).toMatchObject({ status: 302, error: "redirect 302 not followed" });
  });
});

describe("emit → deliver", () => {
  it("a status change emits order.status_changed in its transaction; the delivery is signed and verifiable", async () => {
    const { secret } = await endpoint(A, ["order.status_changed"]);
    const [o] = await pools.admin.select().from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"))).limit(1);
    // a rolled-back change sends nothing
    await expect(inTenant(A, async (c) => {
      await setManualStatus(c, o!.id, "on_hold", "test");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await latestDelivery(A, "order.status_changed")).toBeUndefined();
    // its job was dispatched before the rollback: the delivery simply does not exist
    const [ghost] = drainWebhookJobs();
    expect(await deliverWebhook(app, ghost!, { policy: loopback })).toEqual({ status: "missing" });
    await inTenant(A, (c) => setManualStatus(c, o!.id, "on_hold", "test"));
    const d = await latestDelivery(A, "order.status_changed");
    expect(d).toMatchObject({ status: "pending", attempts: 0 });
    expect(drainWebhookJobs()).toEqual([{ tenantId: A, deliveryId: d!.id }]);
    const payload = d!.payload as { type: string; data: { order: Record<string, unknown>; previousStatus: string; status: string } };
    expect(payload).toMatchObject({ type: "order.status_changed", data: { previousStatus: "confirmed", status: "on_hold" } });
    // no personal data in payloads
    expect(payload.data.order).not.toHaveProperty("email");
    expect(payload.data.order).not.toHaveProperty("customerName");

    const r = await deliverWebhook(app, { tenantId: A, deliveryId: d!.id }, { policy: loopback });
    expect(r).toEqual({ status: "succeeded", code: 200 });
    expect(received).toHaveLength(1);
    const h = received[0]!.headers;
    expect(h[WEBHOOK_HEADERS.id.toLowerCase()]).toBe(d!.id);
    expect(h[WEBHOOK_HEADERS.event.toLowerCase()]).toBe("order.status_changed");
    const check = verifyWebhookSignature({ header: h[WEBHOOK_HEADERS.signature.toLowerCase()] as string, body: received[0]!.body, now: new Date(), hmacHex: (content) => webhookHmac(secret, Number(content.split(".")[0]), content.slice(content.indexOf(".") + 1)) });
    expect(check).toEqual({ ok: true });
    expect(JSON.parse(received[0]!.body).id).toBe(payload.type === "order.status_changed" ? (d!.payload as { id: string }).id : "");
    const done = await latestDelivery(A, "order.status_changed");
    expect(done).toMatchObject({ status: "succeeded", attempts: 1, responseCode: 200 });
    // delivering again is a no-op
    expect(await deliverWebhook(app, { tenantId: A, deliveryId: d!.id }, { policy: loopback })).toEqual({ status: "skipped", reason: "finished" });
  });

  it("failures retry 10 s → 30 s → … → 2 h, then the delivery is dead; a redelivery sends the same event again", async () => {
    await endpoint(A, ["order.status_changed"]);
    const [o] = await pools.admin.select().from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"))).limit(1);
    await inTenant(A, (c) => setManualStatus(c, o!.id, "pending_review"));
    const d = (await latestDelivery(A, "order.status_changed"))!;
    answer = 500;
    let clock = Date.now();
    const delays: number[] = [];
    for (;;) {
      const r = await deliverWebhook(app, { tenantId: A, deliveryId: d.id }, { policy: loopback, now: () => new Date(clock) });
      if (r.status === "retrying") {
        delays.push(r.retryInSeconds);
        // not due yet: skipped
        expect(await deliverWebhook(app, { tenantId: A, deliveryId: d.id }, { policy: loopback, now: () => new Date(clock + 1000 * (r.retryInSeconds - 5)) })).toEqual({ status: "skipped", reason: "not_due" });
        // the tick finds it once due
        const due = await dueWebhookDeliveries(pools.admin as unknown as Database, { now: new Date(clock + 1000 * (r.retryInSeconds + 30)) });
        expect(due.map((x) => x.deliveryId)).toContain(d.id);
        clock += r.retryInSeconds * 1000 + 1000;
        continue;
      }
      expect(r).toMatchObject({ status: "dead", code: 500 });
      break;
    }
    expect(delays).toEqual([10, 30, 120, 600, 1800, 3600, 7200]);
    const dead = await latestDelivery(A, "order.status_changed");
    expect(dead).toMatchObject({ status: "dead", attempts: 8, responseCode: 500, nextAttemptAt: null });
    expect((dead!.attemptLog as unknown[]).length).toBe(8);
    expect(received).toHaveLength(8);

    answer = 200;
    const again = await inTenant(A, (c) => redeliverWebhook(c, d.id));
    expect(await deliverWebhook(app, { tenantId: A, deliveryId: again.id }, { policy: loopback })).toMatchObject({ status: "succeeded" });
    const [copy] = await pools.admin.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, again.id));
    expect(copy).toMatchObject({ eventId: d.eventId, redeliveryOf: d.id, status: "succeeded" });
    const log = await inTenant(A, (c) => listWebhookDeliveries(c, { eventId: d.eventId }));
    expect(log.rows.map((r) => r.status).sort()).toEqual(["dead", "succeeded"]);
    const failed = await inTenant(A, (c) => listWebhookDeliveries(c, { status: "failed" }));
    expect(failed.rows.map((r) => r.id)).toContain(d.id);
  });

  it("paused endpoints receive nothing; a test delivery is tried once even when paused", async () => {
    const { endpoint: ep } = await endpoint(A, ["order.status_changed"]);
    await inTenant(A, (c) => updateWebhookEndpoint(c, ep.id, { isActive: false }, { policy: loopback }));
    const [o] = await pools.admin.select().from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"))).limit(1);
    await inTenant(A, (c) => setManualStatus(c, o!.id, "on_hold"));
    expect(await latestDelivery(A, "order.status_changed")).toBeUndefined();
    answer = 503;
    const t = await inTenant(A, (c) => sendTestWebhook(c, ep.id));
    expect(await deliverWebhook(app, { tenantId: A, deliveryId: t.id }, { policy: loopback })).toMatchObject({ status: "dead", code: 503 });
    expect(JSON.parse(received[0]!.body).type).toBe("webhook.test");
  });

  it("during a rotation both secrets sign, so a receiver with the old one keeps verifying", async () => {
    const { endpoint: ep, secret: oldSecret } = await endpoint(A, ["order.status_changed"]);
    const { secret: newSecret } = await inTenant(A, (c) => rotateWebhookSecret(c, ep.id));
    const t = await inTenant(A, (c) => sendTestWebhook(c, ep.id));
    await deliverWebhook(app, { tenantId: A, deliveryId: t.id }, { policy: loopback });
    const header = received[0]!.headers[WEBHOOK_HEADERS.signature.toLowerCase()] as string;
    expect(header.match(/v1=/g)).toHaveLength(2);
    for (const secret of [oldSecret, newSecret]) expect(verifyWebhookSignature({ header, body: received[0]!.body, now: new Date(), hmacHex: (content) => webhookHmac(secret, Number(content.split(".")[0]), content.slice(content.indexOf(".") + 1)) }).ok).toBe(true);
    const listed = await inTenant(A, (c) => listWebhookEndpoints(c));
    expect(listed[0]!.previousSecretExpiresAt).not.toBeNull();
  });

  it("a stock change crossing the low-stock threshold emits inventory.low_stock once", async () => {
    await endpoint(A, ["inventory.low_stock"]);
    const [level] = await pools.admin.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, A)).orderBy(desc(schema.inventoryLevels.available)).limit(1);
    expect(level!.available).toBeGreaterThan(20);
    // the variant's stock lives in this location only, so its total is this level
    await pools.admin.update(schema.inventoryLevels).set({ available: 0 }).where(and(eq(schema.inventoryLevels.variantId, level!.variantId), sql`${schema.inventoryLevels.id} <> ${level!.id}`));
    const total = level!.available;
    // down to the default threshold (10): crosses once
    const delta = -(total - 10);
    await inTenant(A, (c) => adjustStock(c, { variantId: level!.variantId, locationId: level!.locationId, delta, reason: "damaged" }));
    const d = await latestDelivery(A, "inventory.low_stock");
    expect(d).toBeDefined();
    expect((d!.payload as { data: Record<string, unknown> }).data).toMatchObject({ variantId: level!.variantId, threshold: 10, previousAvailable: total });
    const count = (await pools.admin.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventType, "inventory.low_stock"))).length;
    // already low: another decrease does not fire again
    const [after] = await pools.admin.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.id, level!.id));
    if (after!.available > 0) await inTenant(A, (c) => adjustStock(c, { variantId: level!.variantId, locationId: level!.locationId, delta: -1, reason: "damaged" }));
    expect((await pools.admin.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventType, "inventory.low_stock"))).length).toBe(count);
  });

  it("a store that leaves the plan gets its pending deliveries cancelled, not sent", async () => {
    const { endpoint: ep } = await endpoint(B, ["order.status_changed"], receiverUrl, "owner@harborhome.demo");
    const t = await inTenant(B, (c) => sendTestWebhook(c, ep.id), "owner@harborhome.demo");
    await pools.admin.update(schema.tenants).set({ planKey: "starter" }).where(eq(schema.tenants.id, B));
    try {
      expect(await deliverWebhook(app, { tenantId: B, deliveryId: t.id }, { policy: loopback })).toEqual({ status: "cancelled", reason: "api_unavailable" });
      expect(received).toHaveLength(0);
    } finally {
      await pools.admin.update(schema.tenants).set({ planKey: "growth" }).where(eq(schema.tenants.id, B));
    }
  });
});

describe("order import", () => {
  it("emits order.created and shipment.updated for new platform orders, order.updated with the changed fields; the history backfill emits nothing", async () => {
    await endpoint(A, ["order.created", "order.updated", "shipment.updated"]);
    const variants = await pools.admin.select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, A)).limit(20);
    const locations = await pools.admin.select().from(schema.locations).where(eq(schema.locations.tenantId, A));
    const platform = new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW", startOrderNumber: 700000, seed: 81, variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: {}, priceMinor: v.priceMinor })), locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })), customers: [{ externalId: "c-api-81", email: "buyer81@example.com", phone: null, firstName: "Test", lastName: "Buyer", country: "IT", city: "Milano", zip: "20100", acceptsMarketing: false, tags: [], platformCreatedAt: new Date() }] });
    const run = <T>(fn: (c: ServiceContext) => Promise<T>) => withTenant(A, (tx) => fn({ tenantId: A, tx, actor: { type: "integration", userId: null } }), app);
    const count = async (type: string) => (await pools.admin.select().from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.tenantId, A), eq(schema.webhookDeliveries.eventType, type)))).length;

    const old = platform.generateOrder(new Date(Date.now() - 200 * 864e5));
    await run((c) => importOrder(c, old, { country: "IT", source: "backfill" }));
    expect(await count("order.created")).toBe(0);

    const o = platform.generateOrder(new Date());
    o.fulfillments = [{ externalId: `f-${o.externalId}`, status: "in_transit", externalStatus: "in_transit", trackingNumber: "TRK81", trackingUrl: null, carrier: "Carrier", createdAt: new Date(), updatedAt: new Date(), deliveredAt: null }];
    const first = await run((c) => importOrder(c, o, { country: "IT", source: "webhook" }));
    expect(await count("order.created")).toBe(1);
    const created = await latestDelivery(A, "order.created");
    expect((created!.payload as { data: { order: { id: string } } }).data.order.id).toBe(first.id);
    const shipment = await latestDelivery(A, "shipment.updated");
    expect((shipment!.payload as { data: { shipment: Record<string, unknown>; previousStatus: unknown } }).data).toMatchObject({ shipment: { orderId: first.id, status: "in_transit", trackingNumber: "TRK81" }, previousStatus: null });
    // the same payload again changes nothing
    await run((c) => importOrder(c, o, { country: "IT", source: "webhook" }));
    expect(await count("order.created")).toBe(1);
    expect(await count("order.updated")).toBe(0);

    await platform.cancelOrder(o.externalId, { restock: true, refund: true });
    await run(async (c) => importOrder(c, (await platform.fetchOrder(o.externalId))!, { country: "IT", source: "webhook" }));
    const updated = await latestDelivery(A, "order.updated");
    expect((updated!.payload as { data: { changes: string[]; order: { status: string } } }).data).toMatchObject({ changes: expect.arrayContaining(["cancelledAt"]), order: { status: "cancelled" } });
  });
});

describe("tenant isolation", () => {
  it("tenant B neither sees nor touches tenant A's endpoints and deliveries; A's events never reach B's endpoints", async () => {
    const { endpoint: aEp } = await endpoint(A, ["order.status_changed"]);
    const { endpoint: bEp } = await endpoint(B, ["order.status_changed"], receiverUrl, "owner@harborhome.demo");
    const aTest = await inTenant(A, (c) => sendTestWebhook(c, aEp.id));
    const bc = <T>(fn: (c: ServiceContext) => Promise<T>) => inTenant(B, fn, "owner@harborhome.demo");
    expect((await bc((c) => listWebhookEndpoints(c))).map((e) => e.id)).toEqual([bEp.id]);
    expect((await bc((c) => listWebhookDeliveries(c))).rows.map((r) => r.id)).not.toContain(aTest.id);
    await expect(bc((c) => redeliverWebhook(c, aTest.id))).rejects.toMatchObject({ code: "not_found" });
    await expect(bc((c) => sendTestWebhook(c, aEp.id))).rejects.toMatchObject({ code: "not_found" });
    await expect(bc((c) => rotateWebhookSecret(c, aEp.id))).rejects.toMatchObject({ code: "not_found" });
    // a delivery job naming the wrong tenant finds nothing (RLS)
    expect(await deliverWebhook(app, { tenantId: B, deliveryId: aTest.id }, { policy: loopback })).toEqual({ status: "missing" });
    const [o] = await pools.admin.select().from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"))).limit(1);
    await inTenant(A, (c) => setManualStatus(c, o!.id, "on_hold"));
    const rows = await pools.admin.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventType, "order.status_changed"));
    expect(rows.every((r) => r.endpointId === aEp.id && r.tenantId === A)).toBe(true);
  });
});
