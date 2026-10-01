import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { createPurchaseOrder, receivePurchaseOrder, supplierBalances, transitionPurchaseOrder, variantStock } from "../src";
import type { ServiceContext } from "../src";
import { parseTenantSettings } from "@keel/core";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.harbor;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@harborhome.demo"]! } }), pools.app);

describe("purchase order receiving", () => {
  it("updates stock, cost and status; partial then complete", async () => {
    const supplier = await run(async (s) => (await s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).limit(1))[0]!);
    const location = await run(async (s) => (await s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1))[0]!);
    const variant = await run(async (s) => (await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1))[0]!);
    const before = await run(async (s) => (await s.tx.select({ a: sql<number>`coalesce(sum(available),0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, variant.id)))[0]!.a);
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: location.id, currency: "USD", expectedAt: null, lines: [{ variantId: variant.id, quantity: 20, unitCostMinor: 1234 }] }));
    await expect(run((s) => receivePurchaseOrder(s, { poId, lines: [] }))).rejects.toMatchObject({ code: "invalid_transition" });
    await run((s) => transitionPurchaseOrder(s, poId, "sent"));
    await run((s) => transitionPurchaseOrder(s, poId, "confirmed"));
    const lineId = await run(async (s) => (await s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId)))[0]!.id);
    const pushes: number[] = [];
    const r1 = await run((s) => receivePurchaseOrder(s, { poId, lines: [{ lineId, quantity: 5 }], pushToPlatform: async (_v, _l, available) => void pushes.push(available) }));
    expect(r1.status).toBe("partially_received");
    expect(pushes).toHaveLength(1);
    const r2 = await run((s) => receivePurchaseOrder(s, { poId, lines: [{ lineId, quantity: 99 }] }));
    expect(r2.status).toBe("received");
    expect(r2.received[0]!.quantity).toBe(15);
    const after = await run(async (s) => (await s.tx.select({ a: sql<number>`coalesce(sum(available),0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, variant.id)))[0]!.a);
    expect(after - before).toBe(20);
    const v = await run(async (s) => (await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id)))[0]!);
    expect(v.costMinor).toBe(1234);
    expect(v.costSource).toBe("po_receipt");
    expect(v.costUpdatedAt).toBeInstanceOf(Date);
    expect(v.averageCostMinor).toBeGreaterThan(0);
    const movements = await run((s) => s.tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.variantId, variant.id), eq(schema.inventoryMovements.referenceId, poId))));
    expect(movements.map((m) => m.delta).sort()).toEqual([15, 5]);
    const balances = await run((s) => supplierBalances(s));
    expect(balances.get(supplier.id)!.owedMinor).toBeGreaterThanOrEqual(20 * 1234);
  });
  it("computes velocity and risk from the seed", async () => {
    const rows = await run((s) => variantStock(s, parseTenantSettings({}), {}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => ["critical", "warning", "ok", "no_sales"].includes(r.risk))).toBe(true);
    expect(rows.some((r) => r.available > 0)).toBe(true);
    const ids = rows.slice(0, 3).map((r) => r.variantId);
    const subset = await run((s) => variantStock(s, parseTenantSettings({}), { variantIds: ids }));
    expect(subset.map((r) => r.variantId).sort()).toEqual(ids.sort());
    void inArray;
  });
});
