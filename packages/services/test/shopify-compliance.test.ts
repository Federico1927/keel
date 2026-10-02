import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, ne, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { encryptJson } from "@hullwise/integrations";
import { handleShopifyCompliance, redactCustomer } from "../src";

/**
 * Shopify's mandatory privacy webhooks (#89): signature checked with the secret of the app the store is
 * connected through (tenant credentials, saved app, or the platform app), logged once, turned into a
 * console task; shop/redact also clears the connection.
 */
const pools = testPools();
let ctx: SeedContext;
const PLATFORM_SECRET = "platform-app-secret";
const HARBOR_SECRET = "harbor-client-secret";
const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
let northwindShop = "";
const harborShop = "harbor-compliance.myshopify.com";

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  const [nw] = await pools.admin.select({ shop: schema.integrations.externalAccountId }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantIds.northwind), eq(schema.integrations.provider, "shopify")));
  northwindShop = nw!.shop!;
  await pools.admin.update(schema.integrations).set({ externalAccountId: harborShop, mode: "live", credentialsEncrypted: encryptJson({ shop: harborShop, accessToken: "t", apiSecret: HARBOR_SECRET, clientId: "cid", grant: "client_credentials" }) }).where(and(eq(schema.integrations.tenantId, ctx.tenantIds.harbor), eq(schema.integrations.provider, "shopify")));
});
afterAll(() => pools.close());

const call = (topic: string, shop: string, payload: object, secret: string) => {
  const rawBody = JSON.stringify(payload);
  return handleShopifyCompliance(pools.admin, { topic, shop, rawBody, hmac: sign(rawBody, secret), platformSecret: PLATFORM_SECRET, tenantDb: pools.app });
};

describe("Shopify compliance webhooks", () => {
  it("refuses a bad signature and an unknown topic", async () => {
    expect(await call("customers/redact", northwindShop, { shop_id: 1 }, "wrong")).toMatchObject({ status: 401, action: "invalid_signature" });
    expect(await call("orders/create", northwindShop, { shop_id: 1 }, PLATFORM_SECRET)).toMatchObject({ status: 400, action: "unknown_topic" });
  });

  it("logs a data request once, with an audit entry and a console task, storing no email", async () => {
    const payload = { shop_id: 954889, shop_domain: northwindShop, orders_requested: [299938, 280263], customer: { id: 191167, email: "john@example.com", phone: "555-625-1199" }, data_request: { id: 9999 } };
    expect(await call("customers/data_request", northwindShop, payload, PLATFORM_SECRET)).toMatchObject({ status: 200, tenantId: ctx.tenantIds.northwind, action: "logged" });
    expect(await call("customers/data_request", northwindShop, payload, PLATFORM_SECRET)).toMatchObject({ status: 200, action: "duplicate" });
    const tenantId = ctx.tenantIds.northwind;
    const { events, audit } = await withTenant(tenantId, async (tx) => ({
      events: await tx.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, tenantId), eq(schema.webhookEvents.source, "shopify_compliance"))),
      audit: await tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "integration.compliance.customers.data_request"))),
    }), pools.app);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ topic: "customers/data_request", externalId: "9999", status: "processed" });
    expect(JSON.stringify(events[0]!.payload)).not.toContain("john@example.com");
    expect(audit).toHaveLength(1);
    const alerts = await pools.admin.select().from(schema.platformAlerts).where(and(eq(schema.platformAlerts.kind, "compliance_request"), eq(schema.platformAlerts.tenantId, tenantId)));
    expect(alerts.map((a) => a.subject)).toEqual(["shopify:customers/data_request:9999"]);
    expect(alerts[0]!.status).toBe("open");
  });

  it("customers/redact erases the customer's personal data across tables, keeps the numbers, and needs no task", async () => {
    const tenantId = ctx.tenantIds.northwind;
    const run = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) => withTenant(tenantId, fn, pools.app);
    const [customer] = await run((tx) => tx.select().from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), isNotNull(schema.customers.externalId), isNotNull(schema.customers.email), sql`${schema.customers.ordersCount} > 0`)).limit(1));
    const orders = await run((tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.customerId, customer!.id))));
    expect(orders.length).toBeGreaterThan(0);
    // a guest order of the same person, listed by Shopify in orders_to_redact
    const [guest] = await run((tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), ne(schema.orders.customerId, customer!.id), isNotNull(schema.orders.externalId), isNotNull(schema.orders.email))).limit(1));
    const first = orders[0]!;
    await run(async (tx) => {
      await tx.insert(schema.webhookEvents).values({ tenantId, source: "shopify", topic: "orders/updated", externalId: first.externalId!, sourceUpdatedAt: "redact-test", payload: { id: first.externalId, email: customer!.email }, status: "processed" });
      await tx.insert(schema.webhookEvents).values({ tenantId, source: "shopify", topic: "refunds/create", externalId: "refund-redact-test", sourceUpdatedAt: "redact-test", payload: { id: "refund-redact-test", order_id: guest!.externalId, note: "call +39 333" }, status: "pending" });
      await tx.insert(schema.pixelIdentities).values({ tenantId, anonymousId: "anon-redact-test", customerId: customer!.id, emailSha256: "abc" });
    });

    const payload = { shop_id: 954889, shop_domain: northwindShop, customer: { id: Number(customer!.externalId) || customer!.externalId, email: customer!.email, phone: customer!.phone }, orders_to_redact: [guest!.externalId] };
    expect(await call("customers/redact", northwindShop, payload, PLATFORM_SECRET)).toMatchObject({ status: 200, tenantId, action: "redacted" });
    expect(await call("customers/redact", northwindShop, payload, PLATFORM_SECRET)).toMatchObject({ status: 200, action: "duplicate" });

    const after = await run(async (tx) => ({
      customer: (await tx.select().from(schema.customers).where(eq(schema.customers.id, customer!.id)))[0]!,
      orders: await tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.id} = any(${sql.param([...orders.map((o) => o.id), guest!.id])}::uuid[])`)),
      events: await tx.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, tenantId), eq(schema.webhookEvents.sourceUpdatedAt, "redact-test"))),
      links: await tx.select().from(schema.pixelIdentities).where(and(eq(schema.pixelIdentities.tenantId, tenantId), eq(schema.pixelIdentities.anonymousId, "anon-redact-test"))),
      audit: await tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "customer.redacted"))),
    }));
    expect(after.customer).toMatchObject({ email: null, emailNormalized: null, phone: null, phoneE164: null, firstName: null, lastName: null, city: null, zip: null, acceptsMarketing: false, externalId: customer!.externalId, ordersCount: customer!.ordersCount, totalSpentMinor: customer!.totalSpentMinor });
    expect(after.orders).toHaveLength(orders.length + 1);
    for (const o of after.orders) {
      expect(o).toMatchObject({ customerName: null, email: null, phone: null, shippingAddress: null, billingAddress: null, shippingZip: null, shippingCity: null, addressKey: null, nameZipKey: null, note: null });
      const before = [...orders, guest!].find((b) => b.id === o.id)!;
      expect(o.totalMinor).toBe(before.totalMinor);
      expect(o.status).toBe(before.status);
      expect(o.shippingCountry).toBe(before.shippingCountry);
    }
    expect(after.events.map((e) => e.payload)).toEqual([{ redacted: true }, { redacted: true }]);
    expect(after.events.every((e) => e.status === "processed")).toBe(true);
    expect(after.links).toHaveLength(0);
    expect(after.audit).toHaveLength(1);
    expect(JSON.stringify(after.audit[0]!.metadata)).not.toContain(customer!.email!);
    const alerts = await pools.admin.select().from(schema.platformAlerts).where(and(eq(schema.platformAlerts.kind, "compliance_request"), eq(schema.platformAlerts.tenantId, tenantId)));
    expect(alerts.some((a) => a.subject.startsWith("shopify:customers/redact"))).toBe(false);

    // idempotent: a second run (e.g. a manual request after the webhook) finds nothing left to erase
    const again = await run((tx) => redactCustomer({ tenantId, tx, actor: { type: "system", userId: null } }, { customerId: customer!.id }));
    expect(again).toMatchObject({ customerId: customer!.id, webhookPayloads: 0, browserLinks: 0, conversionPayloads: 0 });
  });

  it("verifies with the tenant's own app secret and clears the connection on shop/redact", async () => {
    expect(await call("shop/redact", harborShop, { shop_id: 777, shop_domain: harborShop }, PLATFORM_SECRET)).toMatchObject({ status: 401 });
    expect(await call("shop/redact", harborShop, { shop_id: 777, shop_domain: harborShop }, HARBOR_SECRET)).toMatchObject({ status: 200, tenantId: ctx.tenantIds.harbor, action: "logged" });
    const [row] = await pools.admin.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantIds.harbor), eq(schema.integrations.provider, "shopify")));
    expect(row).toMatchObject({ status: "not_connected", credentialsEncrypted: null });
    // after the redact the credentials are gone: a further request for the shop is acknowledged by nobody's secret
    expect(await call("customers/redact", harborShop, { shop_id: 777, customer: { id: 1 } }, HARBOR_SECRET)).toMatchObject({ status: 401 });
  });
});
