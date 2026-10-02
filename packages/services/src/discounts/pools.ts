import { randomInt } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, schema, sql, type SQL } from "@hullwise/db";
import { generateUniqueCodes, poolTopUpCount, type PoolCodeStatus } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";
import { linkPoolRedemptions } from "./redemptions";

/* Discount pool lifecycle (issue #35): per-code status, assignment, top-up, export, on/off on the platform. */

export class PoolError extends Error {
  constructor(public readonly code: "not_found" | "invalid_input" | "no_codes_available" | "platform_error" | "pool_inactive") {
    super(code);
  }
}

const d = schema.discounts;
/** The pool code status in SQL, same rule as `poolCodeStatus` in core. */
export const poolCodeStatusSql = sql<PoolCodeStatus>`case when ${d.redeemedOrderId} is not null or ${d.usedCount} > 0 then 'redeemed' when ${d.assignedCustomerId} is not null or ${d.assignedCampaignId} is not null then 'assigned' else 'available' end`;
const statusIs = (s: PoolCodeStatus): SQL =>
  s === "redeemed" ? sql`(${d.redeemedOrderId} is not null or ${d.usedCount} > 0)` : s === "assigned" ? sql`(${d.redeemedOrderId} is null and ${d.usedCount} = 0 and (${d.assignedCustomerId} is not null or ${d.assignedCampaignId} is not null))` : sql`(${d.redeemedOrderId} is null and ${d.usedCount} = 0 and ${d.assignedCustomerId} is null and ${d.assignedCampaignId} is null)`;

async function poolRow(ctx: ServiceContext, poolId: string) {
  const [pool] = await ctx.tx.select().from(schema.discountPools).where(and(eq(schema.discountPools.tenantId, ctx.tenantId), eq(schema.discountPools.id, poolId))).limit(1);
  if (!pool) throw new PoolError("not_found");
  return pool;
}

export interface PoolSummary {
  pool: typeof schema.discountPools.$inferSelect;
  codes: number;
  available: number;
  /** Available and active: what can still be handed out. */
  ready: number;
  assigned: number;
  redeemed: number;
  inactive: number;
}

export async function poolSummaries(ctx: ServiceContext, poolIds?: string[]): Promise<PoolSummary[]> {
  const conds: SQL[] = [eq(schema.discountPools.tenantId, ctx.tenantId)];
  if (poolIds) conds.push(inArray(schema.discountPools.id, poolIds.length ? poolIds : ["00000000-0000-0000-0000-000000000000"]));
  const pools = await ctx.tx.select().from(schema.discountPools).where(and(...conds)).orderBy(sql`${schema.discountPools.createdAt} desc`);
  if (!pools.length) return [];
  const counts = await ctx.tx
    .select({ poolId: d.poolId, codes: sql<number>`count(*)::int`, available: sql<number>`count(*) filter (where ${statusIs("available")})::int`, ready: sql<number>`count(*) filter (where ${statusIs("available")} and ${d.isActive})::int`, assigned: sql<number>`count(*) filter (where ${statusIs("assigned")})::int`, redeemed: sql<number>`count(*) filter (where ${statusIs("redeemed")})::int`, inactive: sql<number>`count(*) filter (where not ${d.isActive})::int` })
    .from(d)
    .where(and(eq(d.tenantId, ctx.tenantId), inArray(d.poolId, pools.map((p) => p.id))))
    .groupBy(d.poolId);
  return pools.map((pool) => {
    const c = counts.find((x) => x.poolId === pool.id);
    return { pool, codes: c?.codes ?? 0, available: c?.available ?? 0, ready: c?.ready ?? 0, assigned: c?.assigned ?? 0, redeemed: c?.redeemed ?? 0, inactive: c?.inactive ?? 0 };
  });
}

export interface PoolCodeFilters {
  status?: PoolCodeStatus | "inactive";
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface PoolCodeRow {
  id: string;
  code: string;
  status: PoolCodeStatus;
  isActive: boolean;
  externalId: string | null;
  assignedCustomerId: string | null;
  assignedCustomerName: string | null;
  assignedCustomerEmail: string | null;
  assignedCampaignId: string | null;
  assignedCampaignName: string | null;
  assignedAt: Date | null;
  redeemedOrderId: string | null;
  redeemedOrderName: string | null;
  redeemedAt: Date | null;
}

function codeConds(ctx: ServiceContext, poolId: string, f: PoolCodeFilters): SQL[] {
  const conds: SQL[] = [eq(d.tenantId, ctx.tenantId), eq(d.poolId, poolId)];
  if (f.status === "inactive") conds.push(eq(d.isActive, false));
  else if (f.status) conds.push(statusIs(f.status));
  if (f.q) conds.push(or(ilike(d.code, `%${f.q}%`), ilike(sql`coalesce(${schema.customers.email}, '')`, `%${f.q}%`), ilike(sql`coalesce(${schema.orders.name}, '')`, `%${f.q}%`))!);
  return conds;
}

function codeQuery(ctx: ServiceContext, poolId: string, f: PoolCodeFilters) {
  const conds = codeConds(ctx, poolId, f);
  return ctx.tx
    .select({ id: d.id, code: d.code, status: poolCodeStatusSql, isActive: d.isActive, externalId: d.externalId, assignedCustomerId: d.assignedCustomerId, assignedCustomerName: sql<string | null>`nullif(trim(concat_ws(' ', ${schema.customers.firstName}, ${schema.customers.lastName})), '')`, assignedCustomerEmail: schema.customers.email, assignedCampaignId: d.assignedCampaignId, assignedCampaignName: schema.campaigns.name, assignedAt: d.assignedAt, redeemedOrderId: d.redeemedOrderId, redeemedOrderName: schema.orders.name, redeemedAt: d.redeemedAt })
    .from(d)
    .leftJoin(schema.customers, eq(schema.customers.id, d.assignedCustomerId))
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, d.assignedCampaignId))
    .leftJoin(schema.orders, eq(schema.orders.id, d.redeemedOrderId))
    .where(and(...conds))
    .$dynamic();
}

/** Codes of a pool with their status, who they were given to and the order that used them. */
export async function listPoolCodes(ctx: ServiceContext, poolId: string, f: PoolCodeFilters = {}): Promise<{ rows: PoolCodeRow[]; total: number; page: number; pageSize: number }> {
  await poolRow(ctx, poolId);
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, f.pageSize ?? 50));
  const rows = await codeQuery(ctx, poolId, f).orderBy(sql`${d.redeemedAt} desc nulls last`, sql`${d.assignedAt} desc nulls last`, asc(d.code)).limit(pageSize).offset((page - 1) * pageSize);
  const [count] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(d).leftJoin(schema.customers, eq(schema.customers.id, d.assignedCustomerId)).leftJoin(schema.orders, eq(schema.orders.id, d.redeemedOrderId)).where(and(...codeConds(ctx, poolId, f)));
  return { rows, total: count?.n ?? 0, page, pageSize };
}

/** Every code of the pool for the CSV export (same filters as the page). */
export async function poolCodesForExport(ctx: ServiceContext, poolId: string, f: Omit<PoolCodeFilters, "page" | "pageSize"> = {}): Promise<PoolCodeRow[]> {
  await poolRow(ctx, poolId);
  return codeQuery(ctx, poolId, f).orderBy(asc(d.code));
}

/** CSV of pool codes; the header is passed in so it can be translated. */
export function poolCodesCsv(rows: PoolCodeRow[], header: string[], format: { date: (d: Date) => string; status: (s: PoolCodeStatus) => string; yes: string; no: string }): string {
  const esc = (v: string | null | undefined) => {
    const s = v ?? "";
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => [r.code, format.status(r.status), r.isActive ? format.yes : format.no, r.assignedCustomerEmail ?? "", r.assignedCampaignName ?? "", r.assignedAt ? format.date(r.assignedAt) : "", r.redeemedOrderName ?? "", r.redeemedAt ? format.date(r.redeemedAt) : ""].map(esc).join(","));
  return [header.map(esc).join(","), ...lines].join("\n") + "\n";
}

export interface AssignInput {
  customerId?: string | null;
  campaignId?: string | null;
  count: number;
}

/**
 * Hands out the next available active codes to one customer or one campaign. Codes are claimed with a row
 * lock that skips codes another request is assigning, so two people never get the same code.
 */
export async function assignPoolCodes(ctx: ServiceContext, poolId: string, input: AssignInput): Promise<{ ids: string[]; codes: string[] }> {
  const pool = await poolRow(ctx, poolId);
  const count = Math.round(input.count);
  if (Boolean(input.customerId) === Boolean(input.campaignId) || count < 1 || count > 1000) throw new PoolError("invalid_input");
  if (!pool.isActive) throw new PoolError("pool_inactive");
  if (input.customerId) {
    const [c] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, input.customerId))).limit(1);
    if (!c) throw new PoolError("invalid_input");
  }
  if (input.campaignId) {
    const [c] = await ctx.tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.id, input.campaignId))).limit(1);
    if (!c) throw new PoolError("invalid_input");
  }
  const free = await ctx.tx.select({ id: d.id }).from(d).where(and(eq(d.tenantId, ctx.tenantId), eq(d.poolId, poolId), eq(d.isActive, true), statusIs("available"))).orderBy(asc(d.code)).limit(count).for("update", { skipLocked: true });
  if (free.length < count) throw new PoolError("no_codes_available");
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.update(d).set({ assignedCustomerId: input.customerId ?? null, assignedCampaignId: input.campaignId ?? null, assignedAt: now, updatedAt: now }).where(inArray(d.id, free.map((f) => f.id))).returning({ id: d.id, code: d.code });
  return { ids: rows.map((r) => r.id), codes: rows.map((r) => r.code).sort() };
}

/** Takes an assigned (not redeemed) code back into the pool. */
export async function releasePoolCode(ctx: ServiceContext, discountId: string): Promise<{ code: string; from: { customerId: string | null; campaignId: string | null } }> {
  const [row] = await ctx.tx.select().from(d).where(and(eq(d.tenantId, ctx.tenantId), eq(d.id, discountId), isNotNull(d.poolId))).limit(1);
  if (!row || row.redeemedOrderId || row.usedCount > 0 || (!row.assignedCustomerId && !row.assignedCampaignId)) throw new PoolError("invalid_input");
  await ctx.tx.update(d).set({ assignedCustomerId: null, assignedCampaignId: null, assignedAt: null, updatedAt: ctx.now ?? new Date() }).where(eq(d.id, row.id));
  return { code: row.code, from: { customerId: row.assignedCustomerId, campaignId: row.assignedCampaignId } };
}

export type PoolPush = (input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null; poolExternalId: string | null }) => Promise<{ externalId: string; imported: string[]; failed: string[] }>;

/**
 * Generates codes until the pool has `target` codes ready to hand out (available and active), pushed to the
 * pool's discount on the platform in one call (`discount.pool` with the pool id, synchronous so the form
 * shows how many the platform accepted). Codes the platform refused are kept inactive.
 */
export async function topUpDiscountPool(ctx: ServiceContext, poolId: string, target: number, push: PoolPush): Promise<{ added: number; imported: number; failed: number; target: number }> {
  const pool = await poolRow(ctx, poolId);
  if (!Number.isFinite(target) || target < 1 || target > 10_000) throw new PoolError("invalid_input");
  if (!pool.isActive) throw new PoolError("pool_inactive");
  const [summary] = await poolSummaries(ctx, [poolId]);
  const n = poolTopUpCount(summary?.ready ?? 0, target);
  const now = ctx.now ?? new Date();
  if (n === 0) {
    await ctx.tx.update(schema.discountPools).set({ targetSize: Math.round(target), updatedAt: now }).where(eq(schema.discountPools.id, pool.id));
    return { added: 0, imported: 0, failed: 0, target: Math.round(target) };
  }
  const taken = (await ctx.tx.select({ code: d.code }).from(d).where(eq(d.tenantId, ctx.tenantId))).map((r) => r.code);
  const codes = generateUniqueCodes(pool.prefix, n, () => randomInt(0, 1_000_000) / 1_000_000, 8, taken);
  let result: { externalId: string; imported: string[]; failed: string[] };
  try {
    result = await push({ title: pool.title, codes, type: pool.type as "percentage" | "fixed_amount", value: pool.value, startsAt: pool.startsAt, endsAt: pool.endsAt, poolExternalId: pool.externalId });
  } catch {
    throw new PoolError("platform_error");
  }
  const imported = new Set(result.imported);
  for (let i = 0; i < codes.length; i += 500) {
    await ctx.tx.insert(d).values(codes.slice(i, i + 500).map((code) => ({ tenantId: ctx.tenantId, externalId: imported.has(code) ? `${result.externalId}:${code}` : null, poolId: pool.id, code, title: null, type: pool.type, value: pool.value, usageLimit: 1, usedCount: 0, startsAt: pool.startsAt, endsAt: pool.endsAt, isActive: imported.has(code), source: "hullwise", syncedAt: now })));
  }
  await ctx.tx.update(schema.discountPools).set({ targetSize: Math.round(target), externalId: pool.externalId ?? result.externalId, status: result.failed.length ? "partial" : pool.status, updatedAt: now }).where(eq(schema.discountPools.id, pool.id));
  return { added: codes.length, imported: imported.size, failed: result.failed.length, target: Math.round(target) };
}

/**
 * Turns a pool off (or back on): locally every code stops (or the codes still usable start again) at once,
 * and the platform change goes through the outbox (`discount_pool.status`), so the pool shows its sync state.
 */
export async function setDiscountPoolActive(ctx: ServiceContext, poolId: string, isActive: boolean): Promise<{ changed: boolean; codes: number; write: PlatformWriteRow | null }> {
  const pool = await poolRow(ctx, poolId);
  if (pool.isActive === isActive) return { changed: false, codes: 0, write: null };
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.discountPools).set({ isActive, updatedAt: now }).where(eq(schema.discountPools.id, pool.id));
  const conds = [eq(d.tenantId, ctx.tenantId), eq(d.poolId, pool.id), eq(d.isActive, !isActive)];
  // turning on again: only codes nobody used yet and that exist on the platform (or were never pushed, as seeded ones)
  if (isActive) conds.push(isNull(d.redeemedOrderId), eq(d.usedCount, 0));
  const codes = await ctx.tx.update(d).set({ isActive, updatedAt: now }).where(and(...conds)).returning({ id: d.id });
  const write = pool.externalId ? await enqueuePlatformWrite(ctx, { kind: "discount_pool.status", entityType: "discount_pool", entityId: pool.id, payload: { poolExternalId: pool.externalId, active: isActive } }) : null;
  return { changed: true, codes: codes.length, write };
}

/** Pool codes linked to the orders that used them, for one pool (run on demand from the pool page). */
export async function refreshPoolRedemptions(ctx: ServiceContext, poolId: string): Promise<number> {
  await poolRow(ctx, poolId);
  return linkPoolRedemptions(ctx, { poolId });
}
