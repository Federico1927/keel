import { and, asc, desc, eq, gte, inArray, lt, or, recordAudit, schema, sql } from "@keel/db";
import { driftLossUnits, normalizeScanCode, reviewStockTake, suggestMarkdown, validateAdjustment, type AdjustmentReason, type MarkdownSkipReason, type MarkdownSuggestion, type StockTakeReview, type TenantSettings } from "@keel/core";
import type { ServiceContext } from "../context";
import type { AuditIdentity } from "../catalog/costs";
import { recordPriceChanges } from "../catalog/price-history";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";
import { refreshBackorderCoverage, type RefreshResult } from "../backorders";
import { SkipItem, newBatchId, runBatch, type BatchSummary } from "../lists/batch";
import type { BulkRunner } from "../lists/bulk";
import { variantStock } from "./index";

/**
 * Inventory control (issue #30): manual adjustments with a reason code, stock-take sessions,
 * the unexplained-loss report and markdown suggestions. Every stock change writes the local level,
 * an `inventory_movements` row and an audit entry in the caller's transaction, enqueues the new
 * absolute level as an `inventory.set` outbox write (the caller dispatches it after the commit) and
 * re-checks the open backorders of variants whose stock went up.
 */

export class InventoryControlError extends Error {
  constructor(public readonly code: "not_found" | "zero" | "sign" | "negative_stock" | "note_required" | "not_open" | "invalid_input") {
    super(code);
    this.name = "InventoryControlError";
  }
}

const identityOf = (ctx: ServiceContext, override?: AuditIdentity): AuditIdentity => override ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", impersonatedBy: null };

async function levelAt(ctx: ServiceContext, variantId: string, locationId: string) {
  const [v] = await ctx.tx.select({ id: schema.productVariants.id, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.id, variantId))).limit(1);
  const [l] = await ctx.tx.select({ id: schema.locations.id, ext: schema.locations.externalId, name: schema.locations.name }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.id, locationId))).limit(1);
  if (!v || !l) throw new InventoryControlError("not_found");
  const [level] = await ctx.tx.select().from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), eq(schema.inventoryLevels.variantId, variantId), eq(schema.inventoryLevels.locationId, locationId))).limit(1).for("update");
  return { variant: v, location: l, level: level ?? null };
}

/** Sets the local level to `next` (available and on hand move by the same delta). */
async function writeLevel(ctx: ServiceContext, variantId: string, locationId: string, level: typeof schema.inventoryLevels.$inferSelect | null, next: number) {
  const delta = next - (level?.available ?? 0);
  if (level) await ctx.tx.update(schema.inventoryLevels).set({ available: next, onHand: Math.max(0, (level.onHand ?? level.available) + delta) }).where(eq(schema.inventoryLevels.id, level.id));
  else await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId, locationId, available: next, onHand: next, committed: 0 });
}

async function pushLevel(ctx: ServiceContext, variantId: string, inv: string | null, locExt: string | null, available: number): Promise<PlatformWriteRow | null> {
  if (!inv || !locExt) return null;
  return enqueuePlatformWrite(ctx, { kind: "inventory.set", entityType: "variant", entityId: variantId, payload: { inventoryItemExternalId: inv, locationExternalId: locExt, available } });
}

/* ---------- adjustments ---------- */

export interface AdjustmentInput {
  variantId: string;
  locationId: string;
  delta: number;
  reason: AdjustmentReason;
  note?: string | null;
}

export interface AdjustmentResult {
  movementId: string;
  before: number;
  after: number;
  write: PlatformWriteRow | null;
  coverage: RefreshResult;
}

/**
 * A manual stock adjustment at one location: validated by `validateAdjustment` (core), written as an
 * `adjustment` movement with its reason code and audited with the level diff; the new level goes to
 * the platform through the outbox (`inventory.set`).
 */
export async function adjustStock(ctx: ServiceContext, input: AdjustmentInput, opts: { pushToPlatform?: boolean; audit?: AuditIdentity } = {}): Promise<AdjustmentResult> {
  const { variant, location, level } = await levelAt(ctx, input.variantId, input.locationId);
  const before = level?.available ?? 0;
  const note = input.note?.trim() || null;
  const check = validateAdjustment({ reason: input.reason, delta: input.delta, current: before, note });
  if (!check.ok) throw new InventoryControlError(check.error);
  const delta = check.next - before;
  await writeLevel(ctx, input.variantId, input.locationId, level, check.next);
  const now = ctx.now ?? new Date();
  const [m] = await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: input.variantId, locationId: input.locationId, delta, reason: "adjustment", reasonCode: input.reason, referenceType: "adjustment", actorUserId: ctx.actor.userId, note, createdAt: now }).returning({ id: schema.inventoryMovements.id });
  const write = opts.pushToPlatform === false ? null : await pushLevel(ctx, input.variantId, variant.inv, location.ext, check.next);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "inventory.adjusted", entityType: "variant", entityId: input.variantId, diff: { [`available@${location.name}`]: { from: before, to: check.next } }, metadata: { locationId: input.locationId, delta, reason: input.reason, note, movementId: m!.id, sku: variant.sku } });
  const coverage = delta > 0 ? await refreshBackorderCoverage(ctx, [input.variantId]) : { releasedOrders: [], released: 0, relinked: 0, writes: [] };
  return { movementId: m!.id, before, after: check.next, write, coverage };
}

/* ---------- stock-take ---------- */

export async function createStockTake(ctx: ServiceContext, input: { locationId: string; note?: string | null }, opts: { audit?: AuditIdentity } = {}): Promise<{ id: string; number: number }> {
  const [loc] = await ctx.tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.id, input.locationId))).limit(1);
  if (!loc) throw new InventoryControlError("not_found");
  const [{ next }] = (await ctx.tx.select({ next: sql<number>`coalesce(max(${schema.stockTakes.number}), 0)::int + 1` }).from(schema.stockTakes).where(eq(schema.stockTakes.tenantId, ctx.tenantId))) as [{ next: number }];
  const [row] = await ctx.tx.insert(schema.stockTakes).values({ tenantId: ctx.tenantId, number: next, locationId: loc.id, note: input.note?.trim() || null, createdBy: ctx.actor.userId, createdAt: ctx.now ?? new Date() }).returning({ id: schema.stockTakes.id, number: schema.stockTakes.number });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "stock_take.created", entityType: "stock_take", entityId: row!.id, metadata: { number: row!.number, locationId: loc.id, location: loc.name } });
  return row!;
}

export async function listStockTakes(ctx: ServiceContext, opts: { limit?: number } = {}) {
  return ctx.tx
    .select({ t: schema.stockTakes, locationName: schema.locations.name, lines: sql<number>`(select count(*)::int from stock_take_counts c where c.stock_take_id = ${schema.stockTakes.id})` })
    .from(schema.stockTakes)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.stockTakes.locationId))
    .where(eq(schema.stockTakes.tenantId, ctx.tenantId))
    .orderBy(sql`case when ${schema.stockTakes.status} = 'open' then 0 else 1 end`, desc(schema.stockTakes.createdAt))
    .limit(opts.limit ?? 50);
}

async function loadTake(ctx: ServiceContext, id: string, lock = false) {
  const q = ctx.tx.select().from(schema.stockTakes).where(and(eq(schema.stockTakes.tenantId, ctx.tenantId), eq(schema.stockTakes.id, id))).limit(1);
  const [t] = lock ? await q.for("update") : await q;
  if (!t) throw new InventoryControlError("not_found");
  return t;
}

export interface StockTakeLine {
  id: string;
  variantId: string | null;
  code: string;
  counted: number;
  expected: number | null;
  delta: number;
  status: StockTakeReview["rows"][number]["status"];
  productId: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  updatedAt: Date;
}

/**
 * A session with its review: open sessions compare counts with the current levels at the location;
 * applied ones show what was written (level before and correction at that moment).
 */
export async function stockTakeDetail(ctx: ServiceContext, id: string) {
  const take = await loadTake(ctx, id);
  const [loc] = await ctx.tx.select({ name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.id, take.locationId)).limit(1);
  const counts = await ctx.tx
    .select({ c: schema.stockTakeCounts, productId: schema.productVariants.productId, productTitle: schema.products.title, variantTitle: schema.productVariants.title, sku: schema.productVariants.sku })
    .from(schema.stockTakeCounts)
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.stockTakeCounts.variantId))
    .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.stockTakeCounts.tenantId, ctx.tenantId), eq(schema.stockTakeCounts.stockTakeId, id)))
    .orderBy(desc(schema.stockTakeCounts.updatedAt));
  const variantIds = counts.map((c) => c.c.variantId).filter((v): v is string => Boolean(v));
  const levels = variantIds.length ? await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: schema.inventoryLevels.available }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), eq(schema.inventoryLevels.locationId, take.locationId), inArray(schema.inventoryLevels.variantId, variantIds))) : [];
  const expected = new Map(levels.map((l) => [l.variantId, l.available]));
  // an applied session keeps the levels it was compared with
  if (take.status === "applied") for (const c of counts) if (c.c.variantId && c.c.expectedAtApply !== null) expected.set(c.c.variantId, c.c.expectedAtApply);
  const review = reviewStockTake(counts.map((c) => ({ id: c.c.id, variantId: c.c.variantId, counted: c.c.counted })), expected);
  const byId = new Map(counts.map((c) => [c.c.id, c]));
  const lines: StockTakeLine[] = review.rows.map((r) => {
    const c = byId.get(r.id)!;
    return { id: r.id, variantId: r.variantId, code: c.c.code, counted: r.counted, expected: r.expected, delta: r.delta, status: r.status, productId: c.productId, productTitle: c.productTitle, variantTitle: c.variantTitle, sku: c.sku, updatedAt: c.c.updatedAt };
  });
  return { take, locationName: loc?.name ?? "—", lines, summary: review.summary };
}

export type ScanOutcome = { kind: "matched"; countId: string; variantId: string; label: string; counted: number } | { kind: "unknown"; countId: string; code: string; counted: number };

/**
 * A typed or scanned code: matched on SKU, then barcode (case-insensitive). `add` counts `quantity`
 * more units (a scan is +1), `set` replaces the count. An unmatched code is kept as an unknown line.
 */
export async function recordStockTakeCount(ctx: ServiceContext, id: string, input: { code: string; quantity: number; mode: "add" | "set" }): Promise<ScanOutcome> {
  const take = await loadTake(ctx, id, true);
  if (take.status !== "open") throw new InventoryControlError("not_open");
  const code = input.code.trim();
  const qty = Math.trunc(input.quantity);
  if (!code || code.length > 120 || !Number.isFinite(qty) || qty < 0 || qty > 1_000_000 || (input.mode === "add" && qty === 0)) throw new InventoryControlError("invalid_input");
  const norm = normalizeScanCode(code);
  const [v] = await ctx.tx
    .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, ctx.tenantId), or(sql`lower(${schema.productVariants.sku}) = ${norm}`, sql`lower(${schema.productVariants.barcode}) = ${norm}`)))
    .orderBy(sql`case when lower(${schema.productVariants.sku}) = ${norm} then 0 else 1 end`, desc(schema.productVariants.isActive), asc(schema.productVariants.sku))
    .limit(1);
  const now = ctx.now ?? new Date();
  const existing = v
    ? (await ctx.tx.select().from(schema.stockTakeCounts).where(and(eq(schema.stockTakeCounts.stockTakeId, id), eq(schema.stockTakeCounts.variantId, v.id))).limit(1))[0]
    : (await ctx.tx.select().from(schema.stockTakeCounts).where(and(eq(schema.stockTakeCounts.stockTakeId, id), sql`${schema.stockTakeCounts.variantId} is null`, sql`lower(${schema.stockTakeCounts.code}) = ${norm}`)).limit(1))[0];
  const counted = input.mode === "set" ? qty : (existing?.counted ?? 0) + qty;
  let countId: string;
  if (existing) {
    await ctx.tx.update(schema.stockTakeCounts).set({ counted, countedBy: ctx.actor.userId, updatedAt: now }).where(eq(schema.stockTakeCounts.id, existing.id));
    countId = existing.id;
  } else {
    const [row] = await ctx.tx.insert(schema.stockTakeCounts).values({ tenantId: ctx.tenantId, stockTakeId: id, variantId: v?.id ?? null, code: v?.sku ?? code, counted, countedBy: ctx.actor.userId, createdAt: now, updatedAt: now }).returning({ id: schema.stockTakeCounts.id });
    countId = row!.id;
  }
  await ctx.tx.update(schema.stockTakes).set({ updatedAt: now }).where(eq(schema.stockTakes.id, id));
  return v ? { kind: "matched", countId, variantId: v.id, label: `${v.productTitle} ${v.title}`.trim(), counted } : { kind: "unknown", countId, code, counted };
}

export async function setStockTakeCount(ctx: ServiceContext, id: string, countId: string, counted: number | null): Promise<void> {
  const take = await loadTake(ctx, id, true);
  if (take.status !== "open") throw new InventoryControlError("not_open");
  if (counted === null) {
    await ctx.tx.delete(schema.stockTakeCounts).where(and(eq(schema.stockTakeCounts.tenantId, ctx.tenantId), eq(schema.stockTakeCounts.stockTakeId, id), eq(schema.stockTakeCounts.id, countId)));
    return;
  }
  if (!Number.isInteger(counted) || counted < 0 || counted > 1_000_000) throw new InventoryControlError("invalid_input");
  const r = await ctx.tx.update(schema.stockTakeCounts).set({ counted, countedBy: ctx.actor.userId, updatedAt: ctx.now ?? new Date() }).where(and(eq(schema.stockTakeCounts.tenantId, ctx.tenantId), eq(schema.stockTakeCounts.stockTakeId, id), eq(schema.stockTakeCounts.id, countId))).returning({ id: schema.stockTakeCounts.id });
  if (!r.length) throw new InventoryControlError("not_found");
}

export interface ApplyStockTakeResult {
  movements: number;
  writes: PlatformWriteRow[];
  coverage: RefreshResult;
  summary: StockTakeReview["summary"];
}

/**
 * Applies a session in one transaction: every counted variant whose count differs from the level
 * gets a `count_correction` adjustment (movement referencing the session, level set to the count,
 * `inventory.set` enqueued). Uncounted variants and unknown codes are left alone. One audit entry
 * lists the differences; the session keeps the level and correction of each line.
 */
export async function applyStockTake(ctx: ServiceContext, id: string, opts: { pushToPlatform?: boolean; audit?: AuditIdentity } = {}): Promise<ApplyStockTakeResult> {
  const take = await loadTake(ctx, id, true);
  if (take.status !== "open") throw new InventoryControlError("not_open");
  const detail = await stockTakeDetail(ctx, id);
  const [loc] = await ctx.tx.select({ ext: schema.locations.externalId, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.id, take.locationId)).limit(1);
  const now = ctx.now ?? new Date();
  const writes: PlatformWriteRow[] = [];
  const raised: string[] = [];
  const differences: { variantId: string; sku: string | null; from: number; to: number }[] = [];
  const movements: (typeof schema.inventoryMovements.$inferInsert)[] = [];
  for (const line of detail.lines) {
    if (!line.variantId) continue;
    const { variant, level } = await levelAt(ctx, line.variantId, take.locationId);
    const before = level?.available ?? 0;
    const delta = line.counted - before;
    await ctx.tx.update(schema.stockTakeCounts).set({ expectedAtApply: before, appliedDelta: delta }).where(eq(schema.stockTakeCounts.id, line.id));
    if (!delta) continue;
    await writeLevel(ctx, line.variantId, take.locationId, level, line.counted);
    movements.push({ tenantId: ctx.tenantId, variantId: line.variantId, locationId: take.locationId, delta, reason: "adjustment", reasonCode: "count_correction", referenceType: "stock_take", referenceId: id, actorUserId: ctx.actor.userId, note: `ST-${take.number}`, createdAt: now });
    differences.push({ variantId: line.variantId, sku: variant.sku, from: before, to: line.counted });
    if (delta > 0) raised.push(line.variantId);
    if (opts.pushToPlatform !== false) {
      const w = await pushLevel(ctx, line.variantId, variant.inv, loc?.ext ?? null, line.counted);
      if (w) writes.push(w);
    }
  }
  if (movements.length) await ctx.tx.insert(schema.inventoryMovements).values(movements);
  await ctx.tx.update(schema.stockTakes).set({ status: "applied", appliedAt: now, appliedBy: ctx.actor.userId, appliedMovements: movements.length, updatedAt: now }).where(eq(schema.stockTakes.id, id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "stock_take.applied", entityType: "stock_take", entityId: id, diff: Object.fromEntries(differences.slice(0, 500).map((d) => [`available:${d.sku ?? d.variantId}@${loc?.name ?? take.locationId}`, { from: d.from, to: d.to }])), metadata: { batchId: id, number: take.number, locationId: take.locationId, movements: movements.length, summary: detail.summary } });
  const coverage = await refreshBackorderCoverage(ctx, raised);
  return { movements: movements.length, writes, coverage, summary: detail.summary };
}

export async function cancelStockTake(ctx: ServiceContext, id: string, opts: { audit?: AuditIdentity } = {}): Promise<void> {
  const take = await loadTake(ctx, id, true);
  if (take.status !== "open") throw new InventoryControlError("not_open");
  await ctx.tx.update(schema.stockTakes).set({ status: "cancelled", updatedAt: ctx.now ?? new Date() }).where(eq(schema.stockTakes.id, id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "stock_take.cancelled", entityType: "stock_take", entityId: id, diff: { status: { from: "open", to: "cancelled" } }, metadata: { number: take.number } });
}

/* ---------- unexplained losses ---------- */

export interface LossRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  units: number;
  valueMinor: number;
  costMissing: boolean;
  events: number;
  lastDetectedAt: Date;
  locations: string[];
}

/**
 * Variants whose stock fell in the period without a sale, cancellation, return, receipt or
 * adjustment to explain it: the falls and unreported levels of the drift log (#24), valued at the
 * variant cost. Each drift row counts once however often it was seen again.
 */
export async function unexplainedLosses(ctx: ServiceContext, opts: { from: Date; to: Date; locationId?: string | null }): Promise<{ rows: LossRow[]; totalUnits: number; totalValueMinor: number; variantsWithoutCost: number }> {
  const where = [eq(schema.inventoryDrift.tenantId, ctx.tenantId), inArray(schema.inventoryDrift.kind, ["unexplained", "not_reported"]), lt(schema.inventoryDrift.delta, 0), gte(schema.inventoryDrift.detectedAt, opts.from), lt(schema.inventoryDrift.detectedAt, opts.to)];
  if (opts.locationId) where.push(eq(schema.inventoryDrift.locationId, opts.locationId));
  const drift = await ctx.tx
    .select({ d: schema.inventoryDrift, productId: schema.productVariants.productId, productTitle: schema.products.title, variantTitle: schema.productVariants.title, sku: schema.productVariants.sku, costMinor: schema.productVariants.costMinor, locationName: schema.locations.name })
    .from(schema.inventoryDrift)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryDrift.variantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.locations, eq(schema.locations.id, schema.inventoryDrift.locationId))
    .where(and(...where));
  const by = new Map<string, LossRow>();
  for (const r of drift) {
    const units = driftLossUnits(r.d.kind, r.d.delta);
    if (!units) continue;
    const row = by.get(r.d.variantId) ?? { variantId: r.d.variantId, productId: r.productId, productTitle: r.productTitle, variantTitle: r.variantTitle, sku: r.sku, units: 0, valueMinor: 0, costMissing: r.costMinor === null, events: 0, lastDetectedAt: r.d.detectedAt, locations: [] };
    row.units += units;
    row.valueMinor += units * (r.costMinor ?? 0);
    row.events++;
    if (r.d.detectedAt > row.lastDetectedAt) row.lastDetectedAt = r.d.detectedAt;
    const ln = r.locationName ?? "*";
    if (!row.locations.includes(ln)) row.locations.push(ln);
    by.set(r.d.variantId, row);
  }
  const rows = [...by.values()].sort((a, b) => b.valueMinor - a.valueMinor || b.units - a.units);
  return { rows, totalUnits: rows.reduce((s, r) => s + r.units, 0), totalValueMinor: rows.reduce((s, r) => s + r.valueMinor, 0), variantsWithoutCost: rows.filter((r) => r.costMissing).length };
}

/* ---------- markdowns ---------- */

export interface MarkdownTenant {
  country: string;
  settings: TenantSettings;
}

export interface MarkdownRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  available: number;
  unitsSold: number;
  daysOfCover: number | null;
  priceMinor: number;
  compareAtMinor: number | null;
  costMinor: number | null;
  suggestion: Extract<MarkdownSuggestion, { kind: "suggest" }>;
}

async function taxFor(ctx: ServiceContext, country: string) {
  const [r] = await ctx.tx.select({ rateBps: schema.tenantTaxRates.rateBps, pricesIncludeTax: schema.tenantTaxRates.pricesIncludeTax }).from(schema.tenantTaxRates).where(and(eq(schema.tenantTaxRates.tenantId, ctx.tenantId), eq(schema.tenantTaxRates.country, country))).limit(1);
  return { taxRateBps: r?.rateBps ?? 0, pricesIncludeTax: r?.pricesIncludeTax ?? true };
}

/**
 * Markdown suggestions for active variants with slow or excess stock (`suggestMarkdown`, core):
 * cover from the sales pace over the tenant's lookback, floor from the variant cost, the tenant's
 * `markdownMinMarginBps` and the home-country tax rate. Skipped variants are counted by reason.
 */
export async function markdownSuggestions(ctx: ServiceContext, tenant: MarkdownTenant, opts: { variantIds?: string[] } = {}): Promise<{ rows: MarkdownRow[]; skipped: Partial<Record<MarkdownSkipReason, number>> }> {
  const stock = await variantStock(ctx, tenant.settings, { variantIds: opts.variantIds });
  if (!stock.length) return { rows: [], skipped: {} };
  const meta = await ctx.tx
    .select({ id: schema.productVariants.id, compareAtMinor: schema.productVariants.compareAtMinor, isActive: schema.productVariants.isActive, status: schema.products.status })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, stock.map((s) => s.variantId))));
  const metaBy = new Map(meta.map((m) => [m.id, m]));
  const tax = await taxFor(ctx, tenant.country);
  const rows: MarkdownRow[] = [];
  const skipped: Partial<Record<MarkdownSkipReason, number>> = {};
  for (const s of stock) {
    const m = metaBy.get(s.variantId);
    if (!m || !m.isActive || m.status !== "active") continue;
    const r = suggestMarkdown({ priceMinor: s.priceMinor, compareAtMinor: m.compareAtMinor, costMinor: s.costMinor, available: s.available, unitsSold: s.unitsSold, daysOfCover: s.daysOfCover, minMarginBps: tenant.settings.markdownMinMarginBps, excessCoverDays: tenant.settings.excessCoverDays, slowCoverDays: tenant.settings.slowCoverDays, ...tax });
    if (r.kind === "skip") {
      skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
      continue;
    }
    rows.push({ variantId: s.variantId, productId: s.productId, productTitle: s.productTitle, variantTitle: s.variantTitle, sku: s.sku, available: s.available, unitsSold: s.unitsSold, daysOfCover: s.daysOfCover, priceMinor: s.priceMinor, compareAtMinor: m.compareAtMinor, costMinor: s.costMinor, suggestion: r });
  }
  // most stock value tied up first
  rows.sort((a, b) => b.available * (b.costMinor ?? 0) - a.available * (a.costMinor ?? 0));
  return { rows, skipped };
}

/**
 * Applies markdowns to the selected variants, one transaction per variant (`runBatch`). Each
 * suggestion is recomputed inside the record's transaction, so a stale or tampered selection can
 * never go below the floor: price and compare-at are written locally, to the price history and the
 * audit log, and a `variant.prices` outbox write is enqueued. The caller dispatches the writes.
 */
export async function applyMarkdowns(runner: BulkRunner, tenant: MarkdownTenant, variantIds: string[], opts: { concurrency: number; batchId?: string }): Promise<{ summary: BatchSummary; writes: PlatformWriteRow[] }> {
  const batchId = opts.batchId ?? newBatchId();
  const writes: PlatformWriteRow[] = [];
  const labels = await runner.run((s) => s.tx.select({ id: schema.productVariants.id, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, runner.tenantId), inArray(schema.productVariants.id, variantIds))));
  const labelBy = new Map(labels.map((l) => [l.id, `${l.productTitle} ${l.title}`.trim()]));
  const items = [...new Set(variantIds)].map((id) => ({ id, label: labelBy.get(id) ?? null }));
  const summary = await runBatch(items, (item) =>
    runner.run(async (s) => {
      const [v] = await s.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, s.tenantId), eq(schema.productVariants.id, item.id))).limit(1).for("update");
      if (!v) throw new SkipItem("not_found");
      const { rows, skipped } = await markdownSuggestions(s, tenant, { variantIds: [item.id] });
      const row = rows[0];
      if (!row) throw new SkipItem((Object.keys(skipped)[0] as string | undefined) ?? "not_eligible");
      const next = { priceMinor: row.suggestion.priceMinor, compareAtMinor: row.suggestion.compareAtMinor };
      await s.tx.update(schema.productVariants).set(next).where(eq(schema.productVariants.id, v.id));
      await recordPriceChanges(s, [{ variantId: v.id, priceBeforeMinor: v.priceMinor, priceAfterMinor: next.priceMinor, compareAtBeforeMinor: v.compareAtMinor, compareAtAfterMinor: next.compareAtMinor }], { source: "markdown", batchId });
      await recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action: "variant.markdown_applied", entityType: "variant", entityId: v.id, diff: { priceMinor: { from: v.priceMinor, to: next.priceMinor }, compareAtMinor: { from: v.compareAtMinor, to: next.compareAtMinor } }, metadata: { batchId, reason: row.suggestion.reason, discountBps: row.suggestion.discountBps, floorPriceMinor: row.suggestion.floorPriceMinor, marginBps: row.suggestion.marginBps, clampedByFloor: row.suggestion.clampedByFloor } });
      if (v.externalId) writes.push(await enqueuePlatformWrite(s, { kind: "variant.prices", entityType: "variant", entityId: v.id, payload: { variantExternalId: v.externalId, patch: next } }));
    }),
  { concurrency: opts.concurrency, batchId });
  await runner.run((s) => recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action: "bulk.variant.markdown", entityType: "variant", metadata: { batchId, total: summary.total, done: summary.done, skipped: summary.skipped, failed: summary.failed, failures: summary.items.filter((i) => i.status !== "done").slice(0, 50).map((i) => ({ id: i.id, status: i.status, reason: i.reason })) } }));
  return { summary, writes };
}
