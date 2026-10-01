import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import {
  addPoCharge,
  bundleReport,
  cashFlowPlan,
  createPurchaseOrder,
  forecastVariants,
  generateDraftPurchaseOrders,
  issueSupplierToken,
  nextPoNumber,
  receivePurchaseOrder,
  replenishmentPlan,
  revenueTargetPlan,
  saveDemandEvent,
  setForecastOverride,
  stockAnalysisReport,
  supplierAcknowledge,
  supplierPoView,
  tenantForSupplierToken,
  transferPlan,
  transitionPurchaseOrder,
  type PlanningTenant,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: PlanningTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.harbor;
  tenant = { id: tenantId, timezone: "America/New_York", currency: "USD", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@harborhome.demo"]! } }), pools.app);
const first = <T>(rows: T[]) => rows[0]!;

describe("forecast", () => {
  it("projects 12 months, applies events by scope and overrides win", async () => {
    const variant = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1)));
    const base = first(await run((s) => forecastVariants(s, tenant, { variantIds: [variant.id] })));
    expect(base.forecast).toHaveLength(12);
    const month = base.forecast[3]!.month;
    await run((s) => saveDemandEvent(s, { name: "Test promo", month, upliftBps: 10000, scope: "product", scopeValue: variant.productId }));
    await run((s) => setForecastOverride(s, { variantId: variant.id, month: base.forecast[5]!.month, units: 777 }));
    const after = first(await run((s) => forecastVariants(s, tenant, { variantIds: [variant.id] })));
    expect(after.forecast[3]!.uplift).toBeGreaterThanOrEqual(1);
    expect(after.forecast[5]!.units).toBe(777);
    expect(after.forecast[5]!.overridden).toBe(true);
    await run((s) => setForecastOverride(s, { variantId: variant.id, month: base.forecast[5]!.month, units: null }));
    const cleared = first(await run((s) => forecastVariants(s, tenant, { variantIds: [variant.id] })));
    expect(cleared.forecast[5]!.overridden).toBe(false);
  });
});

describe("replenishment and auto drafts", () => {
  it("groups suggestions into one draft PO per supplier and does not duplicate them", async () => {
    const plan = await run((s) => replenishmentPlan(s, tenant, {}));
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((r) => r.leadTimeDays > 0)).toBe(true);
    const toOrder = plan.filter((r) => r.shouldOrder && r.supplierId && r.inDraft === 0);
    const created = await run((s) => generateDraftPurchaseOrders(s, tenant));
    expect(new Set(created.map((c) => c.supplierId)).size).toBe(created.length);
    expect(created.reduce((n, c) => n + c.lines, 0)).toBe(toOrder.filter((r) => r.quantity > 0).length);
    const again = await run((s) => generateDraftPurchaseOrders(s, tenant));
    expect(again).toHaveLength(0);
    if (created[0]) {
      const po = await run(async (s) => first(await s.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, created[0]!.id))));
      expect(po.status).toBe("draft");
      expect(po.source).toBe("auto");
    }
  });
});

describe("purchase order numbers", () => {
  it("continue from the highest number of the month even when numbers are sparse", async () => {
    const supplier = await run(async (s) => first(await s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).limit(1)));
    const at = new Date(Date.UTC(2031, 4, 10));
    await run((s) => s.tx.insert(schema.purchaseOrders).values({ tenantId, supplierId: supplier.id, number: "PO-203105-007", status: "draft", currency: "USD", totalMinor: 0 }));
    expect(await run((s) => nextPoNumber(s, at))).toBe("PO-203105-008");
  });
});

describe("landed cost", () => {
  it("allocates charges to lines and receiving writes the landed unit cost", async () => {
    const supplier = await run(async (s) => first(await s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).limit(1)));
    const [v1, v2] = await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(2));
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: v1!.id, quantity: 10, unitCostMinor: 100 }, { variantId: v2!.id, quantity: 10, unitCostMinor: 300 }] }));
    // 1000 by quantity: +50 each; 800 by value: +20 on the 100 line, +60 on the 300 line
    await run((s) => addPoCharge(s, poId, { kind: "freight", amountMinor: 1000, basis: "quantity" }));
    const res = await run((s) => addPoCharge(s, poId, { kind: "duty", amountMinor: 800, basis: "value" }));
    expect(res.map((r) => r.landedUnitCostMinor).sort((a, b) => a - b)).toEqual([170, 410]);
    await run((s) => transitionPurchaseOrder(s, poId, "sent"));
    await run((s) => transitionPurchaseOrder(s, poId, "confirmed"));
    const lines = await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId)));
    await run((s) => receivePurchaseOrder(s, { poId, lines: lines.map((l) => ({ lineId: l.id, quantity: l.quantity })) }));
    const v = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, v1!.id))));
    expect(v.costMinor).toBe(170);
  });
});

describe("supplier confirmation", () => {
  it("resolves the token, shows the order and confirms it with a new date", async () => {
    const supplier = await run(async (s) => first(await s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).limit(1)));
    const variant = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1)));
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: variant.id, quantity: 12, unitCostMinor: 999 }] }));
    const token = await run((s) => issueSupplierToken(s, poId, "orders@supplier.example"));
    expect(await tenantForSupplierToken("short")).toBeNull();
    const found = await tenantForSupplierToken(token, pools.admin);
    expect(found).toMatchObject({ tenantId, poId, state: "active" });
    const view = await run((s) => supplierPoView(s, poId));
    expect(view?.status).toBe("sent");
    expect(view?.lines[0]?.quantity).toBe(12);
    await expect(run((s) => supplierAcknowledge(s, poId, { decision: "problem", note: "" }))).rejects.toThrow("note_required");
    const date = new Date(Date.UTC(2030, 0, 15));
    const r = await run((s) => supplierAcknowledge(s, poId, { decision: "confirm", expectedAt: date, note: "Ships in two batches" }));
    expect(r.status).toBe("confirmed");
    const po = await run(async (s) => first(await s.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId))));
    expect(po.expectedAt?.toISOString()).toBe(date.toISOString());
    expect(po.supplierAckNote).toBe("Ships in two batches");
    const audit = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, poId), eq(schema.auditLogs.action, "purchase_order.supplier_confirmed"))));
    expect(audit).toHaveLength(1);
    // the token of another tenant's PO does not leak into this tenant
    const other = await withTenant(ctx.tenantIds.northwind, (tx) => supplierPoView({ tenantId: ctx.tenantIds.northwind, tx, actor: { type: "system", userId: null } }, poId), pools.app);
    expect(other).toBeNull();
  });
});

describe("reports", () => {
  it("cash flow, stock analysis, transfers, target plan and bundles return coherent shapes", async () => {
    const cf = await run((s) => cashFlowPlan(s, tenant));
    expect(cf.byMonth.every((m, i, a) => i === 0 || m.cumulativeMinor >= a[i - 1]!.cumulativeMinor)).toBe(true);
    expect(cf.committedMinor + cf.plannedMinor).toBe(cf.items.reduce((s, i) => s + i.amountMinor, 0));
    const sa = await run((s) => stockAnalysisReport(s, tenant));
    expect(sa.rows.length).toBeGreaterThan(0);
    expect(sa.rows.every((r) => ["A", "B", "C"].includes(r.abc) && ["X", "Y", "Z"].includes(r.xyz))).toBe(true);
    const tr = await run((s) => transferPlan(s, tenant));
    expect(tr.every((t) => t.units > 0 && t.from.id !== t.to.id)).toBe(true);
    const tp = await run((s) => revenueTargetPlan(s, tenant, 10_000_000, 3));
    expect(tp.rows.length).toBeGreaterThan(0);
    const bundles = await run((s) => bundleReport(s));
    expect(bundles.length).toBeGreaterThan(0);
    expect(bundles.every((b) => b.components.length > 0 && b.available >= 0)).toBe(true);
  });
});
