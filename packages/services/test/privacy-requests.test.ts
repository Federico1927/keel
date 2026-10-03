import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { emailAddressHash } from "@hullwise/integrations";
import { CustomerErasureError, buildCustomerDataPackage, eraseCustomerOnRequest, handleShopifyCompliance, listCustomerExports, listTenantExports, requestCustomerExport, runTenantExport, takeTenantExportFile, unzipFiles, type ServiceContext } from "../src";

/**
 * Privacy requests handled in Hullwise: one customer's data package (GDPR access; Shopify
 * `customers/data_request`), complete and confined to the tenant, and an erasure asked outside the platform.
 */
const pools = testPools();
let ctx: SeedContext;
let northwind = "";
let harbor = "";
const PLATFORM_SECRET = "platform-app-secret";
const run = <T>(tenantId: string, fn: (c: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);

let customer: typeof schema.customers.$inferSelect;
let orderIds: string[] = [];

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  northwind = ctx.tenantIds.northwind;
  harbor = ctx.tenantIds.harbor;
  // a customer with orders, at least one return, an email and an external id
  const r = await pools.admin.execute<{ id: string }>(sql`select c.id from customers c join orders o on o.customer_id = c.id join return_requests rr on rr.order_id = o.id where c.tenant_id = ${northwind}::uuid and c.email is not null and c.external_id is not null group by c.id order by count(distinct o.id) desc, c.id limit 1`);
  const [row] = await pools.admin.select().from(schema.customers).where(eq(schema.customers.id, r.rows[0]!.id));
  customer = row!;
  orderIds = (await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.customerId, customer.id))).map((o) => o.id);
  // rows keyed on the person rather than on the order: a browser link, an opt-out, an email sent to them
  await pools.admin.insert(schema.pixelIdentities).values({ tenantId: northwind, anonymousId: "anon-privacy-test", customerId: customer.id, emailSha256: "x" });
  await pools.admin.insert(schema.emailSuppressions).values({ tenantId: northwind, email: customer.emailNormalized!, reason: "unsubscribe", category: "all", source: "app" }).onConflictDoNothing();
  await pools.admin.insert(schema.recordNotes).values({ tenantId: northwind, entityType: "customer", entityId: customer.id, body: "Asked for a size exchange by phone" });
  await pools.admin.insert(schema.emailMessages).values({ tenantId: northwind, template: "return_update", category: "transactional", kind: "transactional", recipientHash: emailAddressHash(customer.emailNormalized!), recipientMasked: "jo•••@ex•••.com", idempotencyKey: "privacy-test-email", status: "sent" });
});
afterAll(() => pools.close());

describe("customer data package", () => {
  it("holds the profile, every order with its lines, returns and the person-keyed records, and nothing of other customers", async () => {
    const pkg = await run(northwind, (c) => buildCustomerDataPackage(c, { customerId: customer.id }));
    expect(pkg.customer).toMatchObject({ id: customer.id, email: customer.email, external_id: customer.externalId });
    expect(pkg.orders.map((o) => o.id).sort()).toEqual([...orderIds].sort());
    expect(pkg.orders.every((o) => o.customer_id === customer.id)).toBe(true);
    // addresses travel with the orders
    expect(pkg.orders.some((o) => o.shipping_address !== null)).toBe(true);
    const lines = pkg.records.order_lines ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(orderIds.length);
    expect(lines.every((l) => orderIds.includes(String(l.order_id)))).toBe(true);
    expect((pkg.records.return_requests ?? []).length).toBeGreaterThan(0);
    expect((pkg.records.return_requests ?? []).every((r) => orderIds.includes(String(r.order_id)))).toBe(true);
    // second level: rows that point at the returns, not at the order
    const returnIds = (pkg.records.return_requests ?? []).map((r) => String(r.id));
    const returnChildren = Object.entries(pkg.records).filter(([, rows]) => rows.some((r) => returnIds.includes(String(r.return_id))));
    expect(returnChildren.length).toBeGreaterThan(0);
    expect(pkg.records.pixel_identities?.map((p) => p.anonymous_id)).toContain("anon-privacy-test");
    expect(pkg.records.email_suppressions?.[0]).toMatchObject({ email: customer.emailNormalized, reason: "unsubscribe" });
    expect(pkg.records.email_messages?.map((m) => m.template)).toContain("return_update");
    expect(pkg.records.record_notes?.map((n) => n.body)).toContain("Asked for a size exchange by phone");
    expect(JSON.stringify(pkg.records.email_messages)).not.toContain(customer.emailNormalized!);
    // every record carrying a customer id is this customer's; no secret column leaves
    for (const [table, rows] of Object.entries(pkg.records)) {
      for (const r of rows) {
        if ("customer_id" in r && r.customer_id !== null) expect(r.customer_id, table).toBe(customer.id);
        if ("tenant_id" in r) expect(r.tenant_id, table).toBe(northwind);
        expect(Object.keys(r).some((k) => /_encrypted$|_enc$|token_hash$|password/.test(k)), table).toBe(false);
      }
    }
    expect(pkg.counts.orders).toBe(orderIds.length);
    expect(pkg.truncated).toEqual([]);
  });

  it("finds nothing from another tenant, even with the right ids", async () => {
    const pkg = await run(harbor, (c) => buildCustomerDataPackage(c, { customerId: customer.id, customerExternalId: customer.externalId, orderExternalIds: [] }));
    expect(pkg.customer).toBeNull();
    expect(pkg.orders).toEqual([]);
    expect(pkg.records).toEqual({});
  });

  it("covers a guest's orders listed by the platform", async () => {
    const [guest] = await pools.admin.select({ id: schema.orders.id, externalId: schema.orders.externalId }).from(schema.orders).where(and(eq(schema.orders.tenantId, northwind), isNotNull(schema.orders.externalId), sql`${schema.orders.customerId} is distinct from ${customer.id}::uuid`)).limit(1);
    const pkg = await run(northwind, (c) => buildCustomerDataPackage(c, { customerExternalId: "no-such-customer", orderExternalIds: [guest!.externalId!] }));
    expect(pkg.customer).toBeNull();
    expect(pkg.orders.map((o) => o.id)).toEqual([guest!.id]);
  });

  it("is stored as a customer export: a zip with the JSON and the orders CSV, listed on the customer only, downloadable until it expires", async () => {
    const exportId = await run(northwind, (c) => requestCustomerExport(c, { userId: null, customerId: customer.id }));
    expect(await run(northwind, (c) => requestCustomerExport(c, { userId: null, customerId: customer.id }))).toBe(exportId);
    expect(await run(northwind, (c) => runTenantExport(c, exportId))).toMatchObject({ status: "done" });
    const listed = await run(northwind, (c) => listCustomerExports(c.tx, northwind, customer.id));
    expect(listed[0]).toMatchObject({ id: exportId, status: "done" });
    expect((await run(northwind, (c) => listTenantExports(c.tx, northwind))).some((e) => e.id === exportId)).toBe(false);
    const { file, fileName } = await run(northwind, (c) => takeTenantExportFile(c.tx, northwind, exportId, { userId: ctx.userIds["owner@northwind.demo"]!, actorType: "user" }));
    expect(fileName).toMatch(/^customer-.*\.zip$/);
    const files = Object.fromEntries(unzipFiles(file).map((f) => [f.name, f.data.toString("utf8")]));
    expect(Object.keys(files).sort()).toEqual(["customer-data.json", "order_lines.csv", "orders.csv"]);
    const json = JSON.parse(files["customer-data.json"]!) as { customer: { id: string }; orders: unknown[] };
    expect(json.customer.id).toBe(customer.id);
    expect(json.orders).toHaveLength(orderIds.length);
    expect(files["orders.csv"]!.trim().split("\n")).toHaveLength(orderIds.length + 1);
    // the other tenant cannot reach the file
    await expect(run(harbor, (c) => takeTenantExportFile(c.tx, harbor, exportId, { userId: ctx.userIds["owner@harborhome.demo"]!, actorType: "user" }))).rejects.toMatchObject({ code: "not_found" });
    await pools.admin.update(schema.tenantDataExports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.tenantDataExports.id, exportId));
    await expect(run(northwind, (c) => takeTenantExportFile(c.tx, northwind, exportId, { userId: ctx.userIds["owner@northwind.demo"]!, actorType: "user" }))).rejects.toMatchObject({ code: "expired" });
  });

  it("is created by Shopify's customers/data_request and linked from the console task", async () => {
    const [nw] = await pools.admin.select({ shop: schema.integrations.externalAccountId }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, northwind), eq(schema.integrations.provider, "shopify")));
    const payload = { shop_id: 1, shop_domain: nw!.shop, orders_requested: [], customer: { id: customer.externalId, email: customer.email }, data_request: { id: 4242 } };
    const rawBody = JSON.stringify(payload);
    const r = await handleShopifyCompliance(pools.admin, { topic: "customers/data_request", shop: nw!.shop!, rawBody, hmac: createHmac("sha256", PLATFORM_SECRET).update(rawBody, "utf8").digest("base64"), platformSecret: PLATFORM_SECRET, tenantDb: pools.app });
    expect(r).toMatchObject({ status: 200, action: "logged", tenantId: northwind });
    expect(r.exportId).toBeTruthy();
    expect(await run(northwind, (c) => runTenantExport(c, r.exportId!))).toMatchObject({ status: "done" });
    const [row] = await pools.admin.select().from(schema.tenantDataExports).where(eq(schema.tenantDataExports.id, r.exportId!));
    expect(row).toMatchObject({ scope: "customer", subjectCustomerId: customer.id, requestedByType: "system", status: "done" });
    expect(row!.subject).toMatchObject({ requestRef: "shopify:customers/data_request:4242" });
    const [alert] = await pools.admin.select().from(schema.platformAlerts).where(and(eq(schema.platformAlerts.tenantId, northwind), eq(schema.platformAlerts.subject, "shopify:customers/data_request:4242")));
    expect(alert!.meta).toMatchObject({ exportId: r.exportId, customerId: customer.id });
    // platform rows outlive the reseed of the next test file: leave none behind
    await pools.admin.delete(schema.platformAlerts).where(eq(schema.platformAlerts.id, alert!.id));
  });
});

describe("erasure on request", () => {
  it("needs the customer's email typed, then erases and audits who did it", async () => {
    const target = (await pools.admin.select().from(schema.customers).where(and(eq(schema.customers.tenantId, northwind), isNotNull(schema.customers.email), sql`${schema.customers.id} <> ${customer.id}::uuid`, sql`${schema.customers.ordersCount} > 0`)).limit(1))[0]!;
    const superAdmin = ctx.userIds["superadmin@hullwise.demo"]!;
    const asAdmin = <T>(fn: (c: ServiceContext) => Promise<T>) => withTenant(northwind, (tx) => fn({ tenantId: northwind, tx, actor: { type: "user", userId: superAdmin } }), pools.app);
    await expect(asAdmin((c) => eraseCustomerOnRequest(c, { customerId: target.id, confirmation: "someone@else.com", audit: { actorType: "super_admin" } }))).rejects.toBeInstanceOf(CustomerErasureError);
    // the other tenant cannot erase it
    await expect(withTenant(harbor, (tx) => eraseCustomerOnRequest({ tenantId: harbor, tx, actor: { type: "user", userId: superAdmin } }, { customerId: target.id, confirmation: target.email!, audit: { actorType: "super_admin" } }), pools.app)).rejects.toMatchObject({ code: "not_found" });
    const report = await asAdmin((c) => eraseCustomerOnRequest(c, { customerId: target.id, confirmation: ` ${target.email!.toUpperCase()} `, audit: { actorType: "super_admin" } }));
    expect(report).toMatchObject({ customerId: target.id });
    expect(report.orders).toBeGreaterThan(0);
    const [after] = await pools.admin.select().from(schema.customers).where(eq(schema.customers.id, target.id));
    expect(after).toMatchObject({ email: null, firstName: null, phone: null, totalSpentMinor: target.totalSpentMinor });
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, northwind), eq(schema.auditLogs.action, "customer.redacted"), eq(schema.auditLogs.entityId, target.id)));
    expect(audit).toMatchObject({ actorType: "super_admin", actorUserId: superAdmin });
    expect(audit!.metadata).toMatchObject({ source: "request" });
  });
});
