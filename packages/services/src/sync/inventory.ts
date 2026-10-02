import { and, desc, eq, inArray, isNull, lt, or, schema, sql } from "@hullwise/db";
import type { CommercePlatform, NormalizedInventoryLevel } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { unconfirmedWriteTargets } from "../writes";

export type StockReadSource = "sync" | "reconcile" | "webhook" | "manual";

export interface ApplyLevelsResult {
  scanned: number;
  changed: number;
  /** Levels left untouched because a Hullwise stock write is not yet confirmed by the platform. */
  conflicts: number;
  drift: number;
  clamped: number;
  /** Platform pairs Hullwise does not know (unknown item or location). */
  skipped: number;
}

/** Drift rows are deduplicated: the same discrepancy seen again bumps `occurrences`. */
async function logDrift(ctx: ServiceContext, row: { variantId: string; locationId: string | null; kind: "unexplained" | "negative" | "not_reported"; source: StockReadSource; runId: string | null; localBefore: number; expected: number; observed: number; applied: number; detail?: Record<string, unknown>; dedupeKey: string }): Promise<void> {
  const now = ctx.now ?? new Date();
  await ctx.tx
    .insert(schema.inventoryDrift)
    .values({ tenantId: ctx.tenantId, ...row, delta: row.observed - row.expected, detail: row.detail ?? {}, detectedAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: [schema.inventoryDrift.tenantId, schema.inventoryDrift.dedupeKey], set: { occurrences: sql`${schema.inventoryDrift.occurrences} + 1`, lastSeenAt: now, runId: row.runId, source: row.source } });
}

/**
 * Units Hullwise can explain for each variant since a moment: sales take stock away, cancellations of
 * earlier orders bring it back. Sales carry no location, so the check runs per variant.
 */
async function explainedMovement(ctx: ServiceContext, since: Map<string, Date>): Promise<Map<string, number>> {
  if (!since.size) return new Map();
  const ids = [...since.keys()];
  const at = ids.map((id) => since.get(id)!.toISOString());
  const rows = await ctx.tx.execute<{ id: string; n: number }>(sql`
    select v.id, coalesce(sum(case when o.placed_at > v.since and o.cancelled_at is null then -ol.current_quantity when o.placed_at <= v.since and o.cancelled_at > v.since then ol.quantity else 0 end), 0)::int as n
    from unnest(${sql.param(ids)}::uuid[], ${sql.param(at)}::timestamptz[]) as v(id, since)
    join order_lines ol on ol.variant_id = v.id and ol.tenant_id = ${ctx.tenantId}
    join orders o on o.id = ol.order_id
    where o.placed_at > v.since or o.cancelled_at > v.since
    group by v.id`);
  return new Map(rows.rows.map((r) => [r.id, Number(r.n)]));
}

/**
 * Applies stock read from the platform. Negative values are clamped to zero (logged); levels with
 * a Hullwise write still in flight are not overwritten (counted as conflicts); a change no sale,
 * cancellation, receipt or adjustment explains is logged as drift. `synced_at` records the read,
 * so a complete run knows which levels the platform no longer reports.
 */
export async function applyInventoryLevels(ctx: ServiceContext, levels: NormalizedInventoryLevel[], opts: { source: StockReadSource; runId?: string | null }): Promise<ApplyLevelsResult> {
  const out: ApplyLevelsResult = { scanned: levels.length, changed: 0, conflicts: 0, drift: 0, clamped: 0, skipped: 0 };
  if (!levels.length) return out;
  const now = ctx.now ?? new Date();
  const runId = opts.runId ?? null;
  const items = [...new Set(levels.map((l) => l.inventoryItemExternalId))];
  const variants = await ctx.tx.select({ id: schema.productVariants.id, inv: schema.productVariants.inventoryItemExternalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.inventoryItemExternalId, items)));
  const variantByItem = new Map(variants.map((v) => [v.inv!, v.id]));
  const locs = await ctx.tx.select({ id: schema.locations.id, ext: schema.locations.externalId }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), inArray(schema.locations.externalId, [...new Set(levels.map((l) => l.locationExternalId))])));
  const locationByExt = new Map(locs.map((l) => [l.ext!, l.id]));
  const variantIds = variants.map((v) => v.id);
  const local = variantIds.length ? await ctx.tx.select().from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, variantIds))) : [];
  const localBy = new Map(local.map((l) => [`${l.variantId}@${l.locationId}`, l]));
  const inFlight = await unconfirmedWriteTargets(ctx, "inventory.set", levels.map((l) => `inventory:${l.inventoryItemExternalId}@${l.locationExternalId}`));

  // per variant: what Hullwise had, what the platform says, for the levels Hullwise had already read once
  const perVariant = new Map<string, { local: number; observed: number; since: Date; locations: { locationId: string; local: number; observed: number }[] }>();
  for (const lvl of levels) {
    const variantId = variantByItem.get(lvl.inventoryItemExternalId);
    const locationId = locationByExt.get(lvl.locationExternalId);
    if (!variantId || !locationId) {
      out.skipped++;
      continue;
    }
    if (inFlight.has(`inventory:${lvl.inventoryItemExternalId}@${lvl.locationExternalId}`)) {
      out.conflicts++;
      continue;
    }
    const prev = localBy.get(`${variantId}@${locationId}`);
    const applied = Math.max(0, lvl.available);
    if (lvl.available < 0) {
      out.clamped++;
      out.drift++;
      await logDrift(ctx, { variantId, locationId, kind: "negative", source: opts.source, runId, localBefore: prev?.available ?? 0, expected: 0, observed: lvl.available, applied, dedupeKey: `negative:${variantId}@${locationId}:${lvl.available}` });
    }
    if (prev?.syncedAt) {
      const v = perVariant.get(variantId) ?? { local: 0, observed: 0, since: prev.syncedAt, locations: [] };
      v.local += prev.available;
      v.observed += applied;
      if (prev.syncedAt < v.since) v.since = prev.syncedAt;
      v.locations.push({ locationId, local: prev.available, observed: applied });
      perVariant.set(variantId, v);
    }
    if (!prev || prev.available !== applied || prev.onHand !== (lvl.onHand ?? applied) || prev.committed !== (lvl.committed ?? 0)) out.changed++;
    const values = { available: applied, onHand: Math.max(0, lvl.onHand ?? applied), committed: lvl.committed ?? 0, syncedAt: now, updatedAt: now };
    await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId, locationId, ...values }).onConflictDoUpdate({ target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId], set: values });
  }
  const moving = new Map([...perVariant].filter(([, v]) => v.observed !== v.local).map(([id, v]) => [id, v.since]));
  const explained = await explainedMovement(ctx, moving);
  for (const [variantId, v] of perVariant) {
    if (v.observed === v.local) continue;
    const expected = v.local + (explained.get(variantId) ?? 0);
    if (v.observed === expected) continue;
    out.drift++;
    await logDrift(ctx, { variantId, locationId: v.locations.length === 1 ? v.locations[0]!.locationId : null, kind: "unexplained", source: opts.source, runId, localBefore: v.local, expected, observed: v.observed, applied: v.observed, detail: { since: v.since.toISOString(), explained: explained.get(variantId) ?? 0, locations: v.locations }, dedupeKey: `unexplained:${variantId}:${v.local}>${v.observed}` });
  }
  return out;
}

/** Re-reads stock for some variants (after an order, fulfillment or refund webhook, or on demand). */
export async function refreshInventoryForVariants(ctx: ServiceContext, platform: CommercePlatform, variantIds: string[], opts: { source: StockReadSource }): Promise<ApplyLevelsResult> {
  if (!variantIds.length) return { scanned: 0, changed: 0, conflicts: 0, drift: 0, clamped: 0, skipped: 0 };
  const items = (await ctx.tx.select({ inv: schema.productVariants.inventoryItemExternalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, [...new Set(variantIds)]), sql`${schema.productVariants.inventoryItemExternalId} is not null`))).map((r) => r.inv!);
  const levels: NormalizedInventoryLevel[] = [];
  for (let i = 0; i < items.length; i += 100) levels.push(...(await platform.fetchInventoryLevels(items.slice(i, i + 100))));
  return applyInventoryLevels(ctx, levels, opts);
}

/**
 * After a complete run, levels of synced variants the platform did not report (synced before the
 * run started) are stale: set to zero and logged. Levels with a Hullwise write in flight are kept.
 */
export async function zeroUnreportedLevels(ctx: ServiceContext, runStartedAt: Date, opts: { source: StockReadSource; runId: string | null }): Promise<{ zeroed: number; conflicts: number }> {
  const now = ctx.now ?? new Date();
  const stale = await ctx.tx
    .select({ l: schema.inventoryLevels, inv: schema.productVariants.inventoryItemExternalId, loc: schema.locations.externalId })
    .from(schema.inventoryLevels)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId))
    .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
    .where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true), sql`${schema.productVariants.inventoryItemExternalId} is not null`, or(isNull(schema.inventoryLevels.syncedAt), lt(schema.inventoryLevels.syncedAt, runStartedAt)), sql`(${schema.inventoryLevels.available} <> 0 or ${schema.inventoryLevels.onHand} <> 0)`));
  if (!stale.length) return { zeroed: 0, conflicts: 0 };
  const inFlight = await unconfirmedWriteTargets(ctx, "inventory.set", stale.map((s) => `inventory:${s.inv}@${s.loc ?? s.l.locationId}`));
  let zeroed = 0;
  let conflicts = 0;
  for (const s of stale) {
    if (inFlight.has(`inventory:${s.inv}@${s.loc ?? s.l.locationId}`)) {
      conflicts++;
      continue;
    }
    await ctx.tx.update(schema.inventoryLevels).set({ available: 0, onHand: 0, committed: 0, syncedAt: now, updatedAt: now }).where(eq(schema.inventoryLevels.id, s.l.id));
    if (s.l.available !== 0) await logDrift(ctx, { variantId: s.l.variantId, locationId: s.l.locationId, kind: "not_reported", source: opts.source, runId: opts.runId, localBefore: s.l.available, expected: s.l.available, observed: 0, applied: 0, dedupeKey: `not_reported:${s.l.variantId}@${s.l.locationId}:${s.l.available}` });
    zeroed++;
  }
  return { zeroed, conflicts };
}

/** Inventory page: recent drift, newest first. */
export async function recentInventoryDrift(ctx: ServiceContext, opts: { limit?: number } = {}) {
  return ctx.tx
    .select({ d: schema.inventoryDrift, productId: schema.productVariants.productId, productTitle: schema.products.title, variantTitle: schema.productVariants.title, sku: schema.productVariants.sku, locationName: schema.locations.name })
    .from(schema.inventoryDrift)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryDrift.variantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.locations, eq(schema.locations.id, schema.inventoryDrift.locationId))
    .where(eq(schema.inventoryDrift.tenantId, ctx.tenantId))
    .orderBy(desc(schema.inventoryDrift.lastSeenAt))
    .limit(opts.limit ?? 10);
}
