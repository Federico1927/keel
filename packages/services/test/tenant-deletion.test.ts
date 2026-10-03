import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, schema, sql } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockBillingProvider } from "@hullwise/integrations";
import { TenantDeletionError, requestTenantDeletion, runTenantDeletion, tenantDeletionPreview, tenantRowCounts, tenantTablesInDeletionOrder } from "../src";

/**
 * Deleting a tenant from the console: nothing of it is left in any tenant table (iterated from the schema,
 * like the isolation suite), the other tenant is untouched, and the platform keeps a record of the deletion.
 */
const pools = testPools();
let ctx: SeedContext;
let northwind = "";
let harbor = "";
let superAdmin = "";

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  northwind = ctx.tenantIds.northwind;
  harbor = ctx.tenantIds.harbor;
  superAdmin = ctx.userIds["superadmin@hullwise.demo"]!;
});
afterAll(() => pools.close());

describe("tenant deletion", () => {
  it("orders the tenant tables children first", () => {
    const order = tenantTablesInDeletionOrder().map(getTableName);
    expect(order.indexOf("order_lines")).toBeLessThan(order.indexOf("orders"));
    expect(order.indexOf("purchase_orders")).toBeLessThan(order.indexOf("suppliers"));
    expect(order.indexOf("orders")).toBeLessThan(order.indexOf("customers"));
    expect(new Set(order).size).toBe(order.length);
  });

  it("refuses without the typed slug, the demo confirmation or a decision on the final export", async () => {
    await expect(requestTenantDeletion(pools.admin, northwind, { confirmSlug: "northwind" }, superAdmin)).rejects.toMatchObject({ code: "confirmation_mismatch" });
    await expect(requestTenantDeletion(pools.admin, northwind, { confirmSlug: "northwind-apparel" }, superAdmin)).rejects.toMatchObject({ code: "demo_confirmation_required" });
    await expect(requestTenantDeletion(pools.admin, northwind, { confirmSlug: "northwind-apparel", confirmDemo: true }, superAdmin)).rejects.toBeInstanceOf(TenantDeletionError);
    const [t] = await pools.admin.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, northwind));
    expect(t!.status).not.toBe("churned");
  });

  it("deletes every row of the tenant, cancels the subscription, keeps a platform record, leaves the other tenant untouched", async () => {
    const preview = await tenantDeletionPreview(pools.admin, northwind);
    expect(preview!.isDemo).toBe(true);
    expect(Object.keys(preview!.counts).length).toBeGreaterThan(40);
    const harborBefore = await tenantRowCounts(pools.admin, harbor);
    await pools.admin.update(schema.subscriptions).set({ externalSubscriptionId: "mock_sub_delete_test", provider: "mock" }).where(eq(schema.subscriptions.tenantId, northwind));

    const deletionId = await requestTenantDeletion(pools.admin, northwind, { confirmSlug: "northwind-apparel", confirmDemo: true, withoutExport: true, reason: "test" }, superAdmin);
    const [locked] = await pools.admin.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, northwind));
    expect(locked!.status).toBe("churned");
    await expect(requestTenantDeletion(pools.admin, northwind, { confirmSlug: "northwind-apparel", confirmDemo: true, withoutExport: true }, superAdmin)).rejects.toMatchObject({ code: "in_progress" });

    const billing = new MockBillingProvider();
    const r = await runTenantDeletion(pools.admin, deletionId, { provider: billing, webhookCallbackUrl: "https://app.test/api/webhooks/shopify", tenantDb: pools.app });
    expect(r.status).toBe("done");
    expect(billing.cancelled.has("mock_sub_delete_test")).toBe(true);

    // no row of the tenant left anywhere
    for (const t of tenantTablesInDeletionOrder()) {
      const name = getTableName(t);
      const left = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${northwind}::uuid`);
      expect(left.rows[0]!.n, name).toBe(0);
    }
    expect(await pools.admin.select().from(schema.tenants).where(eq(schema.tenants.id, northwind))).toHaveLength(0);
    expect(await tenantRowCounts(pools.admin, harbor)).toEqual(harborBefore);

    const [del] = await pools.admin.select().from(schema.tenantDeletions).where(eq(schema.tenantDeletions.id, deletionId));
    expect(del).toMatchObject({ status: "done", slug: "northwind-apparel", tenantRef: northwind, requestedBy: superAdmin });
    expect(del!.steps.map((s) => s.step)).toEqual(expect.arrayContaining(["disconnect", "billing", "table:orders", "table:customers", "tenant"]));
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(and(isNull(schema.auditLogs.tenantId), eq(schema.auditLogs.action, "tenant.deleted"), eq(schema.auditLogs.entityId, northwind)));
    expect(audit).toMatchObject({ actorType: "super_admin", actorUserId: superAdmin });
    expect(audit!.metadata).toMatchObject({ slug: "northwind-apparel", deletionId });

    // a second run finds the job done
    expect(await runTenantDeletion(pools.admin, deletionId, { provider: billing, webhookCallbackUrl: "x", tenantDb: pools.app })).toMatchObject({ status: "skipped" });
  });
});
