import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { marginFloorPrice } from "@hullwise/core";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;

/**
 * Inventory control demo (issue #30), deterministic (ordered by SKU, no random draws): a few
 * adjustments with reason codes, an applied stock-take with its corrections, an open one being
 * counted (with an unknown code), two unexplained falls for the loss report, and a markdown
 * applied to two variants (price history, compare-at price, never below a 20 % margin floor).
 */
export async function seedInventoryControl(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  const it = key === "northwind";
  const ops = userIds[it ? "ops@northwind.demo" : "ops@harborhome.demo"] ?? userIds[it ? "owner@northwind.demo" : "owner@harborhome.demo"] ?? null;
  const ago = (days: number, hours = 10) => new Date(now.getTime() - days * DAY + (hours - 12) * 36e5);
  const locations = await db.select().from(schema.locations).where(eq(schema.locations.tenantId, tenantId)).orderBy(desc(schema.locations.isDefault), asc(schema.locations.name));
  const main = locations[0];
  if (!main) return;
  const second = locations[1] ?? main;
  const levels = await db
    .select({ variantId: schema.inventoryLevels.variantId, locationId: schema.inventoryLevels.locationId, available: schema.inventoryLevels.available, sku: schema.productVariants.sku, priceMinor: schema.productVariants.priceMinor, compareAtMinor: schema.productVariants.compareAtMinor, costMinor: schema.productVariants.costMinor })
    .from(schema.inventoryLevels)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId))
    .where(and(eq(schema.inventoryLevels.tenantId, tenantId), isNotNull(schema.productVariants.sku)))
    .orderBy(asc(schema.productVariants.sku), asc(schema.inventoryLevels.locationId));
  const atMain = levels.filter((l) => l.locationId === main.id && l.available >= 3);
  const atSecond = levels.filter((l) => l.locationId === second.id && l.available >= 1);
  if (atMain.length < 8) return;

  // adjustments with a reason
  const adj = (l: (typeof atMain)[number], delta: number, reasonCode: string, note: string | null, days: number) => ({ tenantId, variantId: l.variantId, locationId: main.id, delta, reason: "adjustment", reasonCode, referenceType: "adjustment", actorUserId: ops, note, createdAt: ago(days) });
  await db.insert(schema.inventoryMovements).values([
    adj(atMain[0]!, -2, "damaged", it ? "Cartone schiacciato in consegna" : "Crushed in delivery", 3),
    adj(atMain[1]!, -1, "lost", null, 8),
    adj(atMain[2]!, 1, "found", it ? "Ritrovato nello scaffale resi" : "Found on the returns shelf", 15),
  ]);

  // an applied stock-take (two matches, one missing unit, one surplus unit) and an open one
  const [applied] = await db.insert(schema.stockTakes).values({ tenantId, number: 1, locationId: main.id, status: "applied", note: it ? "Inventario di fine trimestre" : "Quarter-end count", createdBy: ops, appliedBy: ops, appliedAt: ago(12, 16), appliedMovements: 2, createdAt: ago(12, 9), updatedAt: ago(12, 16) }).returning({ id: schema.stockTakes.id });
  const counted = atMain.slice(3, 7);
  const deltas = [0, -1, 0, 1];
  await db.insert(schema.stockTakeCounts).values(counted.map((l, i) => ({ tenantId, stockTakeId: applied!.id, variantId: l.variantId, code: l.sku!, counted: l.available, expectedAtApply: l.available - deltas[i]!, appliedDelta: deltas[i]!, countedBy: ops, createdAt: ago(12, 11), updatedAt: ago(12, 11) })));
  await db.insert(schema.inventoryMovements).values(counted.flatMap((l, i) => (deltas[i] ? [{ tenantId, variantId: l.variantId, locationId: main.id, delta: deltas[i]!, reason: "adjustment", reasonCode: "count_correction", referenceType: "stock_take", referenceId: applied!.id, actorUserId: ops, note: "ST-1", createdAt: ago(12, 16) }] : [])));
  const [open] = await db.insert(schema.stockTakes).values({ tenantId, number: 2, locationId: second.id, status: "open", note: it ? "Conteggio a campione" : "Spot check", createdBy: ops, createdAt: ago(0, 9), updatedAt: ago(0, 10) }).returning({ id: schema.stockTakes.id });
  const spot = atSecond.slice(0, 2);
  await db.insert(schema.stockTakeCounts).values([
    ...spot.map((l, i) => ({ tenantId, stockTakeId: open!.id, variantId: l.variantId, code: l.sku!, counted: Math.max(0, l.available - i), countedBy: ops, createdAt: ago(0, 9), updatedAt: ago(0, 9) })),
    { tenantId, stockTakeId: open!.id, variantId: null, code: it ? "8051234000999" : "0012345678905", counted: 1, countedBy: ops, createdAt: ago(0, 10), updatedAt: ago(0, 10) },
  ]);

  // unexplained falls for the loss report (the generator already logs one from the nightly run)
  const fall = (l: (typeof atMain)[number], units: number, days: number) => ({ tenantId, variantId: l.variantId, locationId: main.id, kind: "unexplained", source: "reconcile", runId: null, localBefore: l.available + units, expected: l.available + units, observed: l.available, delta: -units, applied: l.available, detail: { explained: 0, locations: [{ locationId: main.id, local: l.available + units, observed: l.available }] }, dedupeKey: `seed:loss:${l.variantId}:${days}`, occurrences: 1, detectedAt: ago(days, 3), lastSeenAt: ago(days, 3) });
  await db.insert(schema.inventoryDrift).values([fall(atMain[7]!, 2, 9), fall(atMain[4]!, 1, 17)]);

  // a markdown applied nine days ago on two variants with a cost, above a 20 % margin floor
  const [rate] = await db.select({ rateBps: schema.tenantTaxRates.rateBps, pricesIncludeTax: schema.tenantTaxRates.pricesIncludeTax }).from(schema.tenantTaxRates).innerJoin(schema.tenants, and(eq(schema.tenants.id, schema.tenantTaxRates.tenantId), eq(schema.tenants.country, schema.tenantTaxRates.country))).where(eq(schema.tenantTaxRates.tenantId, tenantId)).limit(1);
  const tax = { taxRateBps: rate?.rateBps ?? 0, pricesIncludeTax: rate?.pricesIncludeTax ?? true };
  const batchId = it ? "6b1f6d0e-0b1a-4c3e-9a51-30a0c0de0001" : "6b1f6d0e-0b1a-4c3e-9a51-30a0c0de0002";
  const candidates = [...new Map(levels.filter((l) => l.costMinor !== null && l.costMinor > 0 && l.compareAtMinor === null).map((l) => [l.variantId, l])).values()].slice(-12);
  let done = 0;
  for (const l of candidates) {
    if (done === 2) break;
    const price = Math.max(Math.floor(l.priceMinor * 0.8), marginFloorPrice(l.costMinor!, 2000, tax));
    if (price >= l.priceMinor) continue;
    await db.update(schema.productVariants).set({ priceMinor: price, compareAtMinor: l.priceMinor }).where(eq(schema.productVariants.id, l.variantId));
    await db.insert(schema.priceChanges).values({ tenantId, variantId: l.variantId, priceBeforeMinor: l.priceMinor, priceAfterMinor: price, compareAtBeforeMinor: null, compareAtAfterMinor: l.priceMinor, source: "markdown", batchId, actorUserId: ops, createdAt: ago(9) });
    done++;
  }
}
