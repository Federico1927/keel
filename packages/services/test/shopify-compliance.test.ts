import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { encryptJson } from "@hullwise/integrations";
import { handleShopifyCompliance } from "../src";

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

  it("verifies with the tenant's own app secret and clears the connection on shop/redact", async () => {
    expect(await call("shop/redact", harborShop, { shop_id: 777, shop_domain: harborShop }, PLATFORM_SECRET)).toMatchObject({ status: 401 });
    expect(await call("shop/redact", harborShop, { shop_id: 777, shop_domain: harborShop }, HARBOR_SECRET)).toMatchObject({ status: 200, tenantId: ctx.tenantIds.harbor, action: "logged" });
    const [row] = await pools.admin.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantIds.harbor), eq(schema.integrations.provider, "shopify")));
    expect(row).toMatchObject({ status: "not_connected", credentialsEncrypted: null });
    // after the redact the credentials are gone: a further request for the shop is acknowledged by nobody's secret
    expect(await call("customers/redact", harborShop, { shop_id: 777, customer: { id: 1 } }, HARBOR_SECRET)).toMatchObject({ status: 401 });
  });
});
