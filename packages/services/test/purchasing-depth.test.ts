import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import {
  createPoFromMix,
  createPurchaseOrder,
  deletePurchaseOrder,
  duplicatePurchaseOrder,
  generateDraftPurchaseOrders,
  issueSupplierLink,
  listSupplierLinks,
  listSupplierTerms,
  mixAllocation,
  optionMix,
  receivePurchaseOrder,
  recordSupplierLinkAccess,
  replenishmentPlan,
  resolveSupplierToken,
  revokeSupplierLinks,
  saveCasePack,
  searchPoVariants,
  setDefaultSupplier,
  transitionPurchaseOrder,
  updatePurchaseOrder,
  variantsForBulkSupplier,
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
const run = <T>(fn: (s: ServiceContext) => Promise<T>, now?: Date) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@harborhome.demo"]! }, now }), pools.app);
const first = <T>(rows: T[]) => rows[0]!;
const suppliers = () => run((s) => s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).orderBy(schema.suppliers.name));
const stockOf = (variantId: string) => run(async (s) => first(await s.tx.select({ a: sql<number>`coalesce(sum(available),0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, variantId))).a);

/** A selling variant made critical with nothing incoming and not in any draft, so planning must order it. */
async function sellingVariantToOrder(): Promise<string> {
  const plan = await run((s) => replenishmentPlan(s, tenant, {}));
  const row = plan.filter((r) => r.dailyMean > 0).sort((a, b) => b.dailyMean - a.dailyMean)[0]!;
  await run(async (s) => {
    await s.tx.update(schema.inventoryLevels).set({ available: 0, onHand: 0 }).where(eq(schema.inventoryLevels.variantId, row.variantId));
    await s.tx.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.variantId, row.variantId));
  });
  return row.variantId;
}

describe("default supplier", () => {
  it("setting it on a product makes the next auto-drafted PO use that supplier and cost", async () => {
    const variantId = await sellingVariantToOrder();
    const [current] = await run((s) => listSupplierTerms(s, { variantIds: [variantId] }));
    const other = (await suppliers()).find((x) => x.id !== current!.supplierId)!;
    const changes = await run((s) => setDefaultSupplier(s, [variantId], other.id, { unitCostMinor: 4321, supplierSku: "ALT-1", moq: 1, leadTimeDays: 9 }));
    expect(changes[0]!.diff.supplierId).toEqual({ from: current!.supplierId, to: other.id });
    const [after] = await run((s) => listSupplierTerms(s, { variantIds: [variantId] }));
    expect(after).toMatchObject({ supplierId: other.id, unitCostMinor: 4321, supplierSku: "ALT-1", leadTimeDays: 9 });
    const plan = first(await run((s) => replenishmentPlan(s, tenant, { variantIds: [variantId] })));
    expect(plan).toMatchObject({ supplierId: other.id, unitCostMinor: 4321, leadTimeDays: 9, shouldOrder: true });
    const created = await run((s) => generateDraftPurchaseOrders(s, tenant, { variantIds: [variantId] }));
    expect(created).toHaveLength(1);
    expect(created[0]!.supplierId).toBe(other.id);
    const line = first(await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, created[0]!.id))));
    expect(line.unitCostMinor).toBe(4321);
    // bulk: a filter by SKU prefix finds the variant, clearing removes the default
    const prefix = (await run((s) => listSupplierTerms(s, { variantIds: [variantId] })))[0]!.sku!.slice(0, 4);
    expect(await run((s) => variantsForBulkSupplier(s, { skuPrefix: prefix }))).toContain(variantId);
    await run((s) => setDefaultSupplier(s, [variantId], null));
    expect((await run((s) => listSupplierTerms(s, { variantIds: [variantId] })))[0]!.supplierId).toBe(current!.supplierId);
  });
});

describe("free-text lines and inspection at receipt", () => {
  it("receives a PO with a free-text line; damaged and rejected units never reach stock", async () => {
    const supplier = first(await suppliers());
    const variant = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1)));
    const before = await stockOf(variant.id);
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: variant.id, quantity: 10, unitCostMinor: 777 }, { variantId: null, description: "Shipping cartons", quantity: 5, unitCostMinor: 200 }] }));
    await expect(run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: null, description: " ", quantity: 1, unitCostMinor: 1 }] }))).rejects.toMatchObject({ code: "invalid_quantity" });
    await run((s) => transitionPurchaseOrder(s, poId, "sent"));
    await run((s) => transitionPurchaseOrder(s, poId, "confirmed"));
    const lines = await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId)));
    const cat = lines.find((l) => l.variantId)!;
    const text = lines.find((l) => !l.variantId)!;
    const r = await run((s) => receivePurchaseOrder(s, { poId, lines: [{ lineId: cat.id, quantity: 10, damaged: 2, rejected: 1 }, { lineId: text.id, quantity: 5 }] }));
    expect(r.status).toBe("received");
    expect(r.received).toEqual([expect.objectContaining({ variantId: variant.id, quantity: 7 })]);
    expect(r.inspected.find((i) => i.lineId === cat.id)).toMatchObject({ received: 10, damaged: 2, rejected: 1, good: 7 });
    expect(await stockOf(variant.id)).toBe(before + 7);
    const saved = await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, cat.id)));
    expect(saved[0]).toMatchObject({ receivedQuantity: 10, damagedQuantity: 2, rejectedQuantity: 1 });
    const movements = await run((s) => s.tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, poId), eq(schema.inventoryMovements.variantId, variant.id))));
    expect(movements.map((m) => m.delta)).toEqual([7]);
    const v = first(await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id))));
    expect(v.costMinor).toBe(777);
  });
});

describe("edit, duplicate, delete", () => {
  it("replaces lines of a draft with a diff, duplicates into a draft and deletes only drafts or cancelled POs", async () => {
    const [a, b] = await suppliers();
    const [v1, v2] = await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).orderBy(schema.productVariants.sku).limit(2));
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: a!.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: v1!.id, quantity: 5, unitCostMinor: 100 }] }));
    const res = await run((s) => updatePurchaseOrder(s, poId, { supplierId: b!.id, destinationLocationId: null, expectedAt: null, notes: "Rush", lines: [{ variantId: v1!.id, quantity: 8, unitCostMinor: 100 }, { variantId: v2!.id, quantity: 2, unitCostMinor: 50 }, { variantId: null, description: "Samples", quantity: 1, unitCostMinor: 0 }] }));
    expect(res.diff.supplierId).toEqual({ from: a!.id, to: b!.id });
    expect(res.diff.notes).toEqual({ from: null, to: "Rush" });
    expect(res.lines.added.map((l) => l.variantId ?? l.description)).toEqual([v2!.id, "Samples"]);
    expect(res.lines.changed[0]).toMatchObject({ from: { quantity: 5 }, to: { quantity: 8 } });
    const po = first(await run((s) => s.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId))));
    expect(po.totalMinor).toBe(8 * 100 + 2 * 50);
    // a sent PO keeps its supplier
    await run((s) => transitionPurchaseOrder(s, poId, "sent"));
    await expect(run((s) => updatePurchaseOrder(s, poId, { supplierId: a!.id, destinationLocationId: null, expectedAt: null, notes: null, lines: [{ variantId: v1!.id, quantity: 1, unitCostMinor: 1 }] }))).rejects.toMatchObject({ code: "invalid_transition" });
    await run((s) => updatePurchaseOrder(s, poId, { supplierId: b!.id, destinationLocationId: null, expectedAt: null, notes: null, lines: [{ variantId: v1!.id, quantity: 9, unitCostMinor: 100 }] }));
    const copy = await run((s) => duplicatePurchaseOrder(s, poId));
    const copyPo = first(await run((s) => s.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, copy.id))));
    expect(copyPo).toMatchObject({ status: "draft", supplierId: b!.id, totalMinor: 900 });
    await expect(run((s) => deletePurchaseOrder(s, poId))).rejects.toMatchObject({ code: "invalid_transition" });
    await run((s) => deletePurchaseOrder(s, copy.id));
    await run((s) => transitionPurchaseOrder(s, poId, "cancelled"));
    await run((s) => deletePurchaseOrder(s, poId));
    expect(await run((s) => s.tx.select().from(schema.purchaseOrders).where(inArray(schema.purchaseOrders.id, [poId, copy.id])))).toHaveLength(0);
  });

  it("finds any variant by SKU or title for a new PO", async () => {
    const v = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1)));
    const hits = await run((s) => searchPoVariants(s, tenant.settings, v.sku!.slice(0, 6)));
    expect(hits.map((h) => h.variantId)).toContain(v.id);
    expect(await run((s) => searchPoVariants(s, tenant.settings, "x"))).toEqual([]);
  });
});

describe("supplier links", () => {
  it("expire, are revoked on resend and log every view; legacy tokens move to hashed links", async () => {
    const supplier = first(await suppliers());
    const variant = await run(async (s) => first(await s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).limit(1)));
    const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: null, currency: "USD", expectedAt: null, lines: [{ variantId: variant.id, quantity: 3, unitCostMinor: 10 }] }));
    const one = await run((s) => issueSupplierLink(s, poId, "a@supplier.example"));
    const resolved = (await resolveSupplierToken(one.token, pools.admin))!;
    expect(resolved).toMatchObject({ tenantId, poId, state: "active" });
    await run((s) => recordSupplierLinkAccess(s, resolved, { token: one.token, kind: "view", ip: "203.0.113.9", userAgent: "UA" }));
    // resend: new token, the old one is revoked
    const two = await run((s) => issueSupplierLink(s, poId, "a@supplier.example"));
    expect(two.revoked).toBe(1);
    const old = (await resolveSupplierToken(one.token, pools.admin))!;
    expect(old.state).toBe("revoked");
    await run((s) => recordSupplierLinkAccess(s, old, { token: one.token, kind: "view" }));
    // expiry
    expect((await resolveSupplierToken(two.token, pools.admin, new Date(Date.now() + 31 * 864e5)))!.state).toBe("expired");
    const views = await run((s) => s.tx.select().from(schema.supplierLinkViews).where(eq(schema.supplierLinkViews.purchaseOrderId, poId)));
    expect(views.map((v) => v.outcome).sort()).toEqual(["active", "revoked"]);
    expect(views.find((v) => v.outcome === "active")!.ipHash).toMatch(/^[0-9a-f]{32}$/);
    const audit = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, poId), eq(schema.auditLogs.action, "purchase_order.supplier_link_blocked"))));
    expect(audit).toHaveLength(1);
    const links = await run((s) => listSupplierLinks(s, poId));
    expect(links.map((l) => l.state)).toEqual(["active", "revoked"]);
    expect(await run((s) => revokeSupplierLinks(s, poId))).toBe(1);
    // the stored hash is not the token
    const stored = await run((s) => s.tx.select().from(schema.supplierLinks).where(eq(schema.supplierLinks.purchaseOrderId, poId)));
    expect(stored.every((l) => l.tokenHash !== one.token && l.tokenHash !== two.token)).toBe(true);
    // a token issued before hashing: honoured until 30 days after sending, then migrated on first use
    const legacy = "legacy-token-0123456789abcdef";
    await run((s) => s.tx.update(schema.purchaseOrders).set({ supplierToken: legacy, sentAt: new Date() }).where(eq(schema.purchaseOrders.id, poId)));
    const lr = (await resolveSupplierToken(legacy, pools.admin))!;
    expect(lr).toMatchObject({ linkId: null, state: "active" });
    await run((s) => recordSupplierLinkAccess(s, lr, { token: legacy, kind: "view" }));
    expect((await resolveSupplierToken(legacy, pools.admin))!.linkId).not.toBeNull();
    expect(first(await run((s) => s.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId)))).supplierToken).toBeNull();
    expect(await resolveSupplierToken("short")).toBeNull();
  });

  it("the seeded expired link resolves as expired", async () => {
    const r = await resolveSupplierToken(`seed-expired-${tenantId}`, pools.admin);
    expect(r?.state).toBe("expired");
  });
});

describe("case packs and option mix", () => {
  it("suggests cartons per option group and turns an allocation into PO lines", async () => {
    const product = await run(async (s) => (await s.tx.select().from(schema.products).where(eq(schema.products.tenantId, tenantId))).find((p) => (p.options as { values: string[] }[]).some((o) => o.values.length >= 2))!);
    const option = (product.options as { name: string; values: string[] }[]).find((o) => o.values.length >= 2)!;
    const units = Object.fromEntries(option.values.map((v, i) => [v, i + 1]));
    await expect(run((s) => saveCasePack(s, { name: "Bad", optionName: "Nope", units, productId: product.id }))).rejects.toMatchObject({ code: "invalid_quantity" });
    const { id: packId } = await run((s) => saveCasePack(s, { name: "Test carton", optionName: option.name.toUpperCase(), units, productId: product.id }));
    const mix = (await run((s) => optionMix(s, tenant, product.id, 365)))!;
    expect(mix.variants.length).toBeGreaterThan(0);
    expect(mix.variants.reduce((t, v) => t + v.share, 0)).toBeCloseTo(1, 6);
    expect(mix.packs.map((p) => p.id)).toContain(packId);
    const sug = mix.suggestions.find((x) => x.packId === packId)!;
    expect(sug.groups.length).toBeGreaterThan(0);
    const packsByGroup = Object.fromEntries(sug.groups.map((g) => [g.key, 2]));
    const alloc = mixAllocation(mix, { mode: "packs", packId, packsByGroup });
    const perPack = Object.values(units).reduce((t, n) => t + n, 0);
    expect(Object.values(alloc).reduce((t, n) => t + n, 0)).toBe(2 * perPack * sug.groups.length);
    const supplier = first(await suppliers());
    const res = await run((s) => createPoFromMix(s, tenant, { productId: product.id, supplierId: supplier.id, destinationLocationId: null, expectedAt: null, lookbackDays: 365, allocation: { mode: "units", totalUnits: 37 } }));
    expect(res.units).toBe(37);
    const lines = await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, res.id)));
    expect(lines.reduce((t, l) => t + l.quantity, 0)).toBe(37);
  });
});
