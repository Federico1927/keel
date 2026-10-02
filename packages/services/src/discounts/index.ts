import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { SALE_STATUSES, discountState, generateUniqueCodes, poolCodeStatus, type DiscountState, type DiscountType } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";
import { poolSummaries } from "./pools";

export class DiscountError extends Error {
  constructor(public readonly code: "code_exists" | "invalid_input" | "platform_error" | "not_found") {
    super(code);
  }
}

export interface DiscountRow {
  id: string;
  code: string;
  title: string | null;
  type: string;
  value: number;
  poolId: string | null;
  poolTitle: string | null;
  usageLimit: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  source: string;
  state: DiscountState;
  orders: number;
  discountGivenMinor: number;
  netRevenueMinor: number;
  marginMinor: number;
}

export interface DiscountFilters {
  q?: string;
  state?: DiscountState | "all";
  poolId?: string;
  /** Hide pool member codes from the main list (they are many and identical). */
  hidePoolCodes?: boolean;
  page?: number;
  pageSize?: number;
}

/** Discounts with usage and attributed sale economics (orders in scope that used the code). */
export async function listDiscounts(ctx: ServiceContext, tenant: AnalyticsTenant, f: DiscountFilters = {}) {
  const now = ctx.now ?? new Date();
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, f.pageSize ?? 50);
  const conds: SQL[] = [eq(schema.discounts.tenantId, ctx.tenantId)];
  if (f.q) conds.push(sql`(${schema.discounts.code} ilike ${"%" + f.q + "%"} or coalesce(${schema.discounts.title}, '') ilike ${"%" + f.q + "%"})`);
  if (f.poolId) conds.push(eq(schema.discounts.poolId, f.poolId));
  else if (f.hidePoolCodes) conds.push(sql`${schema.discounts.poolId} is null`);
  const all = await ctx.tx.select({ d: schema.discounts, poolTitle: schema.discountPools.title }).from(schema.discounts).leftJoin(schema.discountPools, eq(schema.discountPools.id, schema.discounts.poolId)).where(and(...conds)).orderBy(desc(schema.discounts.usedCount), schema.discounts.code);
  const withState = all.map((r) => ({ ...r, state: discountState({ type: r.d.type as DiscountType, value: r.d.value, usageLimit: r.d.usageLimit, usedCount: r.d.usedCount, startsAt: r.d.startsAt, endsAt: r.d.endsAt, isActive: r.d.isActive }, now) }));
  const filtered = f.state && f.state !== "all" ? withState.filter((r) => r.state === f.state) : withState;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const codes = pageRows.map((r) => r.d.code);
  const usage = codes.length
    ? await ctx.tx.select({ code: schema.orderDiscounts.code, orders: sql<number>`count(distinct ${schema.orders.id})::int`, given: sql<number>`coalesce(sum(${schema.orderDiscounts.amountMinor}), 0)::int`, orderIds: sql<string[]>`array_agg(distinct ${schema.orders.id})` }).from(schema.orderDiscounts).innerJoin(schema.orders, eq(schema.orders.id, schema.orderDiscounts.orderId)).where(and(eq(schema.orderDiscounts.tenantId, ctx.tenantId), inArray(schema.orderDiscounts.code, codes), inArray(schema.orders.status, [...SALE_STATUSES]))).groupBy(schema.orderDiscounts.code)
    : [];
  const orderIds = usage.flatMap((u) => u.orderIds);
  const economics = orderIds.length ? await orderEconomicsForPeriod(ctx, tenant, { from: new Date(0), to: new Date(now.getTime() + 864e5) }, { orderIds }) : [];
  const ecoByOrder = new Map(economics.map((e) => [e.orderId, e]));
  const rows: DiscountRow[] = pageRows.map((r) => {
    const u = usage.find((x) => x.code === r.d.code);
    const eco = (u?.orderIds ?? []).map((id) => ecoByOrder.get(id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    return { id: r.d.id, code: r.d.code, title: r.d.title, type: r.d.type, value: r.d.value, poolId: r.d.poolId, poolTitle: r.poolTitle, usageLimit: r.d.usageLimit, usedCount: r.d.usedCount, startsAt: r.d.startsAt, endsAt: r.d.endsAt, isActive: r.d.isActive, source: r.d.source, state: r.state, orders: u?.orders ?? 0, discountGivenMinor: u?.given ?? 0, netRevenueMinor: eco.reduce((s, e) => s + e.netRevenueMinor, 0), marginMinor: eco.reduce((s, e) => s + e.marginMinor, 0) };
  });
  const stateCounts = withState.reduce<Record<string, number>>((acc, r) => ((acc[r.state] = (acc[r.state] ?? 0) + 1), acc), {});
  return { rows, total: filtered.length, page, pageSize, stateCounts };
}

export async function discountDetail(ctx: ServiceContext, tenant: AnalyticsTenant, discountId: string) {
  const [d] = await ctx.tx.select().from(schema.discounts).where(and(eq(schema.discounts.tenantId, ctx.tenantId), eq(schema.discounts.id, discountId))).limit(1);
  if (!d) return null;
  const pool = d.poolId ? (await ctx.tx.select().from(schema.discountPools).where(eq(schema.discountPools.id, d.poolId)).limit(1))[0] ?? null : null;
  const orders = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, status: schema.orders.status, customerName: schema.orders.customerName, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, amountMinor: schema.orderDiscounts.amountMinor }).from(schema.orderDiscounts).innerJoin(schema.orders, eq(schema.orders.id, schema.orderDiscounts.orderId)).where(and(eq(schema.orderDiscounts.tenantId, ctx.tenantId), eq(schema.orderDiscounts.code, d.code))).orderBy(desc(schema.orders.placedAt)).limit(200);
  const saleIds = orders.filter((o) => (SALE_STATUSES as readonly string[]).includes(o.status)).map((o) => o.id);
  const economics = saleIds.length ? await orderEconomicsForPeriod(ctx, tenant, { from: new Date(0), to: new Date(Date.now() + 864e5) }, { orderIds: saleIds }) : [];
  const state = discountState({ type: d.type as DiscountType, value: d.value, usageLimit: d.usageLimit, usedCount: d.usedCount, startsAt: d.startsAt, endsAt: d.endsAt, isActive: d.isActive }, ctx.now ?? new Date());
  // pool codes: status, who got the code and the order that used it
  const [redeemedOrder] = d.redeemedOrderId ? await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt }).from(schema.orders).where(eq(schema.orders.id, d.redeemedOrderId)).limit(1) : [];
  const [assignedCustomer] = d.assignedCustomerId ? await ctx.tx.select({ id: schema.customers.id, email: schema.customers.email, firstName: schema.customers.firstName, lastName: schema.customers.lastName }).from(schema.customers).where(eq(schema.customers.id, d.assignedCustomerId)).limit(1) : [];
  const [assignedCampaign] = d.assignedCampaignId ? await ctx.tx.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, d.assignedCampaignId)).limit(1) : [];
  const poolStatus = d.poolId ? poolCodeStatus(d) : null;
  return { discount: d, pool, state, poolStatus, redeemedOrder: redeemedOrder ?? null, assignedCustomer: assignedCustomer ?? null, assignedCampaign: assignedCampaign ?? null, orders, totals: { orders: saleIds.length, given: orders.reduce((s, o) => s + o.amountMinor, 0), netRevenueMinor: economics.reduce((s, e) => s + e.netRevenueMinor, 0), marginMinor: economics.reduce((s, e) => s + e.marginMinor, 0) } };
}

export interface CreateCodeInput {
  code: string;
  title: string;
  type: DiscountType;
  value: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  minimumAmountMinor?: number | null;
}

/** Platform first (callback), then the local row with the external id; the unique index guards duplicates. */
/**
 * Single code. With `push` the platform is called first (synchronous: the caller needs the answer);
 * without it the code is created locally and its platform write is enqueued in the outbox (the
 * external id is filled in when the write succeeds).
 */
export async function createDiscountCode(ctx: ServiceContext, input: CreateCodeInput, push?: (input: CreateCodeInput) => Promise<{ externalId: string }>): Promise<string> {
  const code = input.code.trim().toUpperCase();
  if (!code || !input.title.trim() || input.value < 0) throw new DiscountError("invalid_input");
  const [existing] = await ctx.tx.select({ id: schema.discounts.id }).from(schema.discounts).where(and(eq(schema.discounts.tenantId, ctx.tenantId), eq(schema.discounts.code, code))).limit(1);
  if (existing) throw new DiscountError("code_exists");
  let externalId: string | null = null;
  if (push) {
    try {
      externalId = (await push({ ...input, code })).externalId;
    } catch {
      throw new DiscountError("platform_error");
    }
  }
  const [row] = await ctx.tx.insert(schema.discounts).values({ tenantId: ctx.tenantId, externalId, code, title: input.title.trim(), type: input.type, value: Math.round(input.value), minimumAmountMinor: input.minimumAmountMinor ?? null, usageLimit: input.usageLimit ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, isActive: true, source: "hullwise", syncedAt: push ? (ctx.now ?? new Date()) : null }).returning({ id: schema.discounts.id });
  if (!push) await enqueuePlatformWrite(ctx, { kind: "discount.create", entityType: "discount", entityId: row!.id, payload: { code, title: input.title.trim(), type: input.type, value: Math.round(input.value), startsAt: input.startsAt?.toISOString() ?? null, endsAt: input.endsAt?.toISOString() ?? null, usageLimit: input.usageLimit ?? null, minimumAmountMinor: input.minimumAmountMinor ?? null } });
  return row!.id;
}

export interface CreatePoolInput {
  title: string;
  prefix: string;
  type: "percentage" | "fixed_amount";
  value: number;
  size: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

/** Bulk pool of unique single-use codes: generated locally, pushed in one call, stored with the platform outcome. */
export async function createDiscountPool(ctx: ServiceContext, input: CreatePoolInput, push: (input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null }) => Promise<{ externalId: string; imported: string[]; failed: string[] }>): Promise<{ poolId: string; imported: number; failed: number }> {
  const size = Math.round(input.size);
  if (!input.title.trim() || size < 1 || size > 10000 || input.value < 0) throw new DiscountError("invalid_input");
  const taken = (await ctx.tx.select({ code: schema.discounts.code }).from(schema.discounts).where(eq(schema.discounts.tenantId, ctx.tenantId))).map((r) => r.code);
  const codes = generateUniqueCodes(input.prefix, size, () => randomInt(0, 1_000_000) / 1_000_000, 8, taken);
  let result: { externalId: string; imported: string[]; failed: string[] };
  try {
    result = await push({ title: input.title, codes, type: input.type, value: Math.round(input.value), startsAt: input.startsAt, endsAt: input.endsAt });
  } catch {
    throw new DiscountError("platform_error");
  }
  const imported = new Set(result.imported);
  const [pool] = await ctx.tx.insert(schema.discountPools).values({ tenantId: ctx.tenantId, title: input.title.trim(), prefix: input.prefix.toUpperCase(), type: input.type, value: Math.round(input.value), targetSize: size, status: result.failed.length ? "partial" : "ready", externalId: result.externalId, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, createdBy: ctx.actor.userId }).returning({ id: schema.discountPools.id });
  const now = ctx.now ?? new Date();
  for (let i = 0; i < codes.length; i += 500) {
    await ctx.tx.insert(schema.discounts).values(codes.slice(i, i + 500).map((code) => ({ tenantId: ctx.tenantId, externalId: imported.has(code) ? `${result.externalId}:${code}` : null, poolId: pool!.id, code, title: null, type: input.type, value: Math.round(input.value), usageLimit: 1, usedCount: 0, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, isActive: imported.has(code), source: "hullwise", syncedAt: now })));
  }
  return { poolId: pool!.id, imported: imported.size, failed: result.failed.length };
}

/** Pools with their code counts by status (`used` = redeemed, kept for older callers). */
export async function listDiscountPools(ctx: ServiceContext) {
  return (await poolSummaries(ctx)).map((p) => ({ ...p, used: p.redeemed }));
}

/**
 * Turns one code on or off: locally at once, on the platform through the outbox (`discount.status`), so the
 * code shows its sync state. A pool code goes to its pool's discount; a code whose pool was never pushed
 * changes locally only.
 */
export async function setDiscountActive(ctx: ServiceContext, discountId: string, isActive: boolean): Promise<{ changed: boolean; write: PlatformWriteRow | null }> {
  const [row] = await ctx.tx.select({ d: schema.discounts, poolExternalId: schema.discountPools.externalId }).from(schema.discounts).leftJoin(schema.discountPools, eq(schema.discountPools.id, schema.discounts.poolId)).where(and(eq(schema.discounts.tenantId, ctx.tenantId), eq(schema.discounts.id, discountId))).limit(1);
  if (!row) throw new DiscountError("not_found");
  if (row.d.isActive === isActive) return { changed: false, write: null };
  await ctx.tx.update(schema.discounts).set({ isActive, updatedAt: ctx.now ?? new Date() }).where(eq(schema.discounts.id, row.d.id));
  const onPlatform = row.d.poolId ? Boolean(row.poolExternalId) : true;
  const write = onPlatform ? await enqueuePlatformWrite(ctx, { kind: "discount.status", entityType: "discount", entityId: row.d.id, payload: { code: row.d.code, discountExternalId: row.d.poolId ? null : row.d.externalId, poolExternalId: row.poolExternalId ?? null, active: isActive } }) : null;
  return { changed: true, write };
}

export * from "./pools";
export * from "./redemptions";
