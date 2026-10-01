import { and, eq, gte, inArray, schema, sql } from "@keel/db";
import {
  addMonthsKey,
  allocateLandedCost,
  bundleAvailability,
  cashOutByMonth,
  cashOutSchedule,
  explodeBom,
  forecastDemand,
  planFromRevenueTarget,
  reorderPlan,
  seasonalityIndices,
  stockAnalysis,
  stockoutDate,
  transferSuggestions,
  wape,
  type CashOut,
  type DemandEvent,
  type ForecastPoint,
  type MonthlySales,
  type ReorderPlan,
  type StockAnalysisRow,
  type TenantSettings,
} from "@keel/core";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";
import type { ServiceContext } from "../context";
import { createPurchaseOrder, nextPoNumber } from "../purchasing";
import { issueSupplierLink } from "../purchasing/links";

const SALE = "('confirmed','fulfilling','shipped','delivered','returned_partial')";
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export interface PlanningTenant {
  id: string;
  timezone: string;
  currency: string;
  settings: TenantSettings;
}

/* ---------- histories ---------- */

interface VariantInfo {
  id: string;
  productId: string;
  productTitle: string;
  productType: string | null;
  title: string;
  sku: string | null;
  priceMinor: number;
  costMinor: number | null;
  packSize: number | null;
}

async function variantsOf(ctx: ServiceContext, opts: { variantIds?: string[]; productIds?: string[] } = {}): Promise<VariantInfo[]> {
  const conds = [eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true)];
  if (opts.variantIds) conds.push(inArray(schema.productVariants.id, opts.variantIds.length ? opts.variantIds : ["00000000-0000-0000-0000-000000000000"]));
  if (opts.productIds) conds.push(inArray(schema.productVariants.productId, opts.productIds.length ? opts.productIds : ["00000000-0000-0000-0000-000000000000"]));
  return ctx.tx
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, productTitle: schema.products.title, productType: schema.products.productType, title: schema.productVariants.title, sku: schema.productVariants.sku, priceMinor: schema.productVariants.priceMinor, costMinor: schema.productVariants.costMinor, packSize: schema.productVariants.packSize })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(...conds));
}

/** Units sold per variant and month (tenant timezone), last `months` months, sale orders only. */
async function monthlySales(ctx: ServiceContext, tz: string, months: number, variantIds?: string[]): Promise<Map<string, MonthlySales[]>> {
  const rows = await ctx.tx.execute<{ variant_id: string; month: string; units: number }>(sql`
    select l.variant_id, to_char(o.placed_at at time zone ${tz}, 'YYYY-MM') as month, sum(l.current_quantity)::int as units
    from order_lines l join orders o on o.id = l.order_id
    where o.tenant_id = ${ctx.tenantId} and o.status in ${sql.raw(SALE)} and l.variant_id is not null
      and o.placed_at >= date_trunc('month', now() at time zone ${tz}) - make_interval(months => ${months})
      and o.placed_at < date_trunc('month', now() at time zone ${tz})
      ${variantIds ? sql`and l.variant_id = any(${sql.param(variantIds)}::uuid[])` : sql``}
    group by 1, 2`);
  const out = new Map<string, MonthlySales[]>();
  for (const r of rows.rows) {
    const arr = out.get(r.variant_id) ?? [];
    arr.push({ month: r.month, units: Number(r.units) });
    out.set(r.variant_id, arr);
  }
  return out;
}

/** Fills missing months with zero between the first sale and last month. */
function denseHistory(points: MonthlySales[] | undefined, lastMonth: string, months: number): MonthlySales[] {
  const map = new Map((points ?? []).map((p) => [p.month, p.units]));
  const out: MonthlySales[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const m = addMonthsKey(lastMonth, -k);
    out.push({ month: m, units: map.get(m) ?? 0 });
  }
  const first = out.findIndex((p) => p.units > 0);
  return first < 0 ? [] : out.slice(first);
}

/** Daily demand mean and standard deviation over the last `days` days per variant. */
async function dailyStats(ctx: ServiceContext, tz: string, days: number, variantIds?: string[]): Promise<Map<string, { mean: number; sd: number }>> {
  const rows = await ctx.tx.execute<{ variant_id: string; day: string; units: number }>(sql`
    select l.variant_id, to_char((o.placed_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, sum(l.current_quantity)::int as units
    from order_lines l join orders o on o.id = l.order_id
    where o.tenant_id = ${ctx.tenantId} and o.status in ${sql.raw(SALE)} and l.variant_id is not null and o.placed_at >= now() - make_interval(days => ${days})
      ${variantIds ? sql`and l.variant_id = any(${sql.param(variantIds)}::uuid[])` : sql``}
    group by 1, 2`);
  const per = new Map<string, number[]>();
  for (const r of rows.rows) {
    const arr = per.get(r.variant_id) ?? [];
    arr.push(Number(r.units));
    per.set(r.variant_id, arr);
  }
  const out = new Map<string, { mean: number; sd: number }>();
  for (const [id, vals] of per) {
    const sum = vals.reduce((s, v) => s + v, 0);
    const mean = sum / days;
    const sq = vals.reduce((s, v) => s + (v - mean) ** 2, 0) + (days - vals.length) * mean ** 2;
    out.set(id, { mean, sd: Math.sqrt(sq / Math.max(1, days - 1)) });
  }
  return out;
}

/* ---------- forecast ---------- */

export interface VariantForecast {
  variantId: string;
  productId: string;
  label: string;
  sku: string | null;
  history: MonthlySales[];
  forecast: ForecastPoint[];
  /** Backtest on the last 3 months: forecast made 3 months ago vs actual. */
  wape: number | null;
}

async function eventsFor(ctx: ServiceContext): Promise<(DemandEvent & { scope: string; scopeValue: string | null })[]> {
  const rows = await ctx.tx.select().from(schema.demandEvents).where(eq(schema.demandEvents.tenantId, ctx.tenantId));
  return rows.map((r) => ({ month: r.month, uplift: r.upliftBps / 10000, label: r.name, scope: r.scope, scopeValue: r.scopeValue }));
}

/**
 * 12-month forecast per variant. Seasonality is learnt on the product type (pooled, more robust
 * than a single SKU), level and trend on the variant; events apply by scope; overrides win.
 */
export async function forecastVariants(ctx: ServiceContext, tenant: PlanningTenant, opts: { variantIds?: string[]; productIds?: string[]; horizon?: number } = {}): Promise<VariantForecast[]> {
  const variants = await variantsOf(ctx, opts);
  if (!variants.length) return [];
  const now = ctx.now ?? new Date();
  const current = monthKey(now);
  const lastClosed = addMonthsKey(current, -1);
  const ids = variants.map((v) => v.id);
  const hist = await monthlySales(ctx, tenant.timezone, 24, opts.variantIds || opts.productIds ? ids : undefined);
  // pooled seasonality per product type, from all variants of the type
  const typeHist = new Map<string, Map<string, number>>();
  const allTypes = await ctx.tx.select({ id: schema.productVariants.id, type: schema.products.productType }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, ctx.tenantId));
  const typeOf = new Map(allTypes.map((t) => [t.id, t.type ?? "—"]));
  const pool = opts.variantIds || opts.productIds ? await monthlySales(ctx, tenant.timezone, 24) : hist;
  for (const [vid, pts] of pool) {
    const ty = typeOf.get(vid) ?? "—";
    const m = typeHist.get(ty) ?? new Map<string, number>();
    for (const p of pts) m.set(p.month, (m.get(p.month) ?? 0) + p.units);
    typeHist.set(ty, m);
  }
  const seasonByType = new Map([...typeHist].map(([ty, m]) => [ty, seasonalityIndices(denseHistory([...m].map(([month, units]) => ({ month, units })), lastClosed, 24))]));
  const events = await eventsFor(ctx);
  const overrides = await ctx.tx.select().from(schema.forecastOverrides).where(and(eq(schema.forecastOverrides.tenantId, ctx.tenantId), gte(schema.forecastOverrides.month, current)));
  return variants.map((v) => {
    const history = denseHistory(hist.get(v.id), lastClosed, 24);
    const season = seasonByType.get(v.productType ?? "—");
    const evs = events.filter((e) => e.scope === "all" || (e.scope === "product_type" && e.scopeValue === v.productType) || (e.scope === "product" && e.scopeValue === v.productId));
    const ov = Object.fromEntries(overrides.filter((o) => o.variantId === v.id).map((o) => [o.month, o.units]));
    const forecast = forecastDemand(history, current, { horizon: opts.horizon ?? 12, seasonality: season, events: evs, overrides: ov });
    let backtest: number | null = null;
    if (history.length >= 9) {
      const train = history.slice(0, -3);
      const test = history.slice(-3);
      const f = forecastDemand(train, test[0]!.month, { horizon: 3, seasonality: season });
      backtest = wape(test.map((t) => t.units), f.map((p) => p.units));
    }
    return { variantId: v.id, productId: v.productId, label: `${v.productTitle} ${v.title}`.trim(), sku: v.sku, history, forecast, wape: backtest };
  });
}

/** Sum of variant forecasts for one product (chart on the planning page). */
export async function productForecast(ctx: ServiceContext, tenant: PlanningTenant, productId: string) {
  const rows = await forecastVariants(ctx, tenant, { productIds: [productId] });
  const months = new Map<string, { month: string; history: number | null; forecast: number | null }>();
  for (const r of rows) {
    for (const h of r.history) {
      const cur = months.get(h.month) ?? { month: h.month, history: 0, forecast: null };
      cur.history = (cur.history ?? 0) + h.units;
      months.set(h.month, cur);
    }
    for (const f of r.forecast) {
      const cur = months.get(f.month) ?? { month: f.month, history: null, forecast: 0 };
      cur.forecast = (cur.forecast ?? 0) + f.units;
      months.set(f.month, cur);
    }
  }
  return { variants: rows, series: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)) };
}

export async function saveDemandEvent(ctx: ServiceContext, input: { name: string; month: string; upliftBps: number; scope: "all" | "product_type" | "product"; scopeValue?: string | null }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error("invalid_month");
  const [row] = await ctx.tx.insert(schema.demandEvents).values({ tenantId: ctx.tenantId, name: input.name.trim().slice(0, 80), month: input.month, upliftBps: Math.max(-9000, Math.min(50000, Math.round(input.upliftBps))), scope: input.scope, scopeValue: input.scope === "all" ? null : (input.scopeValue ?? null) }).returning({ id: schema.demandEvents.id });
  return row!.id;
}

export async function deleteDemandEvent(ctx: ServiceContext, id: string) {
  await ctx.tx.delete(schema.demandEvents).where(and(eq(schema.demandEvents.tenantId, ctx.tenantId), eq(schema.demandEvents.id, id)));
}

export async function listDemandEvents(ctx: ServiceContext) {
  return ctx.tx.select().from(schema.demandEvents).where(eq(schema.demandEvents.tenantId, ctx.tenantId)).orderBy(schema.demandEvents.month);
}

export async function setForecastOverride(ctx: ServiceContext, input: { variantId: string; month: string; units: number | null; note?: string | null }) {
  if (input.units === null) {
    await ctx.tx.delete(schema.forecastOverrides).where(and(eq(schema.forecastOverrides.tenantId, ctx.tenantId), eq(schema.forecastOverrides.variantId, input.variantId), eq(schema.forecastOverrides.month, input.month)));
    return;
  }
  await ctx.tx.insert(schema.forecastOverrides).values({ tenantId: ctx.tenantId, variantId: input.variantId, month: input.month, units: Math.max(0, Math.round(input.units)), note: input.note ?? null, createdBy: ctx.actor.userId }).onConflictDoUpdate({ target: [schema.forecastOverrides.tenantId, schema.forecastOverrides.variantId, schema.forecastOverrides.month], set: { units: Math.max(0, Math.round(input.units)), note: input.note ?? null } });
}

/* ---------- replenishment ---------- */

export interface ReplenishmentRow extends ReorderPlan {
  variantId: string;
  productId: string;
  label: string;
  sku: string | null;
  available: number;
  incoming: number;
  backordered: number;
  dailyMean: number;
  supplierId: string | null;
  supplierName: string | null;
  leadTimeDays: number;
  unitCostMinor: number | null;
  moq: number | null;
  multiple: number | null;
  stockoutDate: string | null;
  /** Units already in an open auto draft PO for this variant. */
  inDraft: number;
}

/**
 * Per variant: stock position, demand (the higher of the recent daily pace and the next two
 * months of forecast), supplier conditions, and the reorder decision with safety stock for the
 * tenant's service level. Sorted by urgency (stock-out first).
 */
export async function replenishmentPlan(ctx: ServiceContext, tenant: PlanningTenant, opts: { onlyToOrder?: boolean; productIds?: string[]; variantIds?: string[] } = {}): Promise<ReplenishmentRow[]> {
  const variants = await variantsOf(ctx, { productIds: opts.productIds, variantIds: opts.variantIds });
  if (!variants.length) return [];
  const ids = variants.map((v) => v.id);
  const [levels, incoming, backorders, stats, sv, suppliers, drafts, forecasts] = [
    await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, ids))).groupBy(schema.inventoryLevels.variantId),
    await ctx.tx.select({ variantId: schema.purchaseOrderLines.variantId, n: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}),0)::int` }).from(schema.purchaseOrderLines).innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId)).where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), inArray(schema.purchaseOrderLines.variantId, ids), inArray(schema.purchaseOrders.status, ["sent", "confirmed", "in_transit", "partially_received"]))).groupBy(schema.purchaseOrderLines.variantId),
    await ctx.tx.select({ variantId: schema.backorders.variantId, n: sql<number>`coalesce(sum(${schema.backorders.quantity}),0)::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.variantId, ids), eq(schema.backorders.status, "pending"))).groupBy(schema.backorders.variantId),
    await dailyStats(ctx, tenant.timezone, 90, ids),
    await ctx.tx.select().from(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), inArray(schema.supplierVariants.variantId, ids))),
    await ctx.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenantId)),
    await ctx.tx.select({ variantId: schema.purchaseOrderLines.variantId, n: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity}),0)::int` }).from(schema.purchaseOrderLines).innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId)).where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), inArray(schema.purchaseOrderLines.variantId, ids), eq(schema.purchaseOrders.status, "draft"))).groupBy(schema.purchaseOrderLines.variantId),
    await forecastVariants(ctx, tenant, { variantIds: ids, horizon: 2 }),
  ];
  const lv = new Map(levels.map((l) => [l.variantId, l.available]));
  const inc = new Map(incoming.map((l) => [l.variantId!, l.n]));
  const bo = new Map(backorders.map((b) => [b.variantId, b.n]));
  const dr = new Map(drafts.map((d) => [d.variantId!, d.n]));
  const fc = new Map(forecasts.map((f) => [f.variantId, f.forecast.reduce((s, p) => s + p.units, 0) / 61]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const serviceLevel = tenant.settings.serviceLevelBps / 10000;
  const today = ctx.now ?? new Date();
  const rows: ReplenishmentRow[] = variants.map((v) => {
    const st = stats.get(v.id) ?? { mean: 0, sd: 0 };
    const dailyMean = Math.max(st.mean, fc.get(v.id) ?? 0);
    const link = sv.filter((x) => x.variantId === v.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
    const supplier = link ? supplierById.get(link.supplierId) : undefined;
    const leadTimeDays = link?.leadTimeDays ?? supplier?.leadTimeDays ?? 21;
    const moq = link?.moq ?? supplier?.moqDefault ?? null;
    const multiple = link?.orderMultiple ?? supplier?.orderMultipleDefault ?? v.packSize ?? null;
    const unitCostMinor = link?.unitCostMinor ?? v.costMinor ?? null;
    const plan = reorderPlan({ available: lv.get(v.id) ?? 0, incoming: inc.get(v.id) ?? 0, backordered: bo.get(v.id) ?? 0, dailyMean, dailySd: st.sd, leadTimeDays, leadTimeSdDays: supplier?.leadTimeSdDays ?? 0, serviceLevel, coverDays: tenant.settings.reviewDays, moq, multiple, unitCostMinor });
    const so = stockoutDate(lv.get(v.id) ?? 0, dailyMean, today);
    return { ...plan, variantId: v.id, productId: v.productId, label: `${v.productTitle} ${v.title}`.trim(), sku: v.sku, available: lv.get(v.id) ?? 0, incoming: inc.get(v.id) ?? 0, backordered: bo.get(v.id) ?? 0, dailyMean: Math.round(dailyMean * 100) / 100, supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null, leadTimeDays, unitCostMinor, moq, multiple, stockoutDate: so.date ? so.date.toISOString().slice(0, 10) : null, inDraft: dr.get(v.id) ?? 0 };
  });
  const filtered = opts.onlyToOrder ? rows.filter((r) => r.shouldOrder) : rows;
  return filtered.sort((a, b) => Number(b.shouldOrder) - Number(a.shouldOrder) || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity));
}

/**
 * Turns the reorder suggestions into draft purchase orders, one per supplier, skipping variants
 * already in a draft and variants without a supplier. Returns the created POs.
 */
export async function generateDraftPurchaseOrders(ctx: ServiceContext, tenant: PlanningTenant, opts: { variantIds?: string[] } = {}): Promise<{ id: string; number: string; supplierId: string; lines: number; totalMinor: number }[]> {
  const plan = (await replenishmentPlan(ctx, tenant, { onlyToOrder: true, variantIds: opts.variantIds })).filter((r) => r.supplierId && r.inDraft === 0 && r.quantity > 0);
  const bySupplier = new Map<string, ReplenishmentRow[]>();
  for (const r of plan) {
    const arr = bySupplier.get(r.supplierId!) ?? [];
    arr.push(r);
    bySupplier.set(r.supplierId!, arr);
  }
  const [loc] = await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isDefault, true))).limit(1);
  const out: { id: string; number: string; supplierId: string; lines: number; totalMinor: number }[] = [];
  for (const [supplierId, rows] of bySupplier) {
    const lead = Math.max(...rows.map((r) => r.leadTimeDays));
    const id = await createPurchaseOrder(ctx, { supplierId, currency: tenant.currency, destinationLocationId: loc?.id ?? null, expectedAt: new Date((ctx.now ?? new Date()).getTime() + lead * 864e5), notes: null, lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity, unitCostMinor: r.unitCostMinor ?? 0 })) });
    await ctx.tx.update(schema.purchaseOrders).set({ source: "auto" }).where(eq(schema.purchaseOrders.id, id));
    const [po] = await ctx.tx.select({ number: schema.purchaseOrders.number, total: schema.purchaseOrders.totalMinor }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
    out.push({ id, number: po!.number, supplierId, lines: rows.length, totalMinor: po!.total });
  }
  return out;
}

export { nextPoNumber };

/* ---------- landed cost ---------- */

export async function listPoCharges(ctx: ServiceContext, poId: string) {
  return ctx.tx.select().from(schema.purchaseOrderCharges).where(and(eq(schema.purchaseOrderCharges.tenantId, ctx.tenantId), eq(schema.purchaseOrderCharges.purchaseOrderId, poId))).orderBy(schema.purchaseOrderCharges.createdAt);
}

/** Recomputes `landed_unit_cost_minor` of every line from the PO's charges. */
export async function recomputeLandedCost(ctx: ServiceContext, poId: string): Promise<{ lineId: string; landedUnitCostMinor: number }[]> {
  const lines = await ctx.tx.select({ id: schema.purchaseOrderLines.id, quantity: schema.purchaseOrderLines.quantity, unitCostMinor: schema.purchaseOrderLines.unitCostMinor, weightGrams: schema.productVariants.weightGrams }).from(schema.purchaseOrderLines).leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.purchaseOrderLines.variantId)).where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), eq(schema.purchaseOrderLines.purchaseOrderId, poId)));
  const charges = await listPoCharges(ctx, poId);
  const res = allocateLandedCost(lines.map((l) => ({ id: l.id, quantity: l.quantity, unitCostMinor: l.unitCostMinor, weightGrams: l.weightGrams })), charges.map((c) => ({ kind: c.kind as "duty", amountMinor: c.amountMinor, basis: c.basis as "value" })));
  for (const r of res) await ctx.tx.update(schema.purchaseOrderLines).set({ landedUnitCostMinor: charges.length ? r.landedUnitCostMinor : null }).where(eq(schema.purchaseOrderLines.id, r.id));
  return res.map((r) => ({ lineId: r.id, landedUnitCostMinor: r.landedUnitCostMinor }));
}

export async function addPoCharge(ctx: ServiceContext, poId: string, input: { kind: "duty" | "freight" | "fee" | "other"; amountMinor: number; basis: "value" | "quantity" | "weight"; note?: string | null }) {
  const [po] = await ctx.tx.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId))).limit(1);
  if (!po) throw new Error("not_found");
  await ctx.tx.insert(schema.purchaseOrderCharges).values({ tenantId: ctx.tenantId, purchaseOrderId: poId, kind: input.kind, amountMinor: Math.max(0, Math.round(input.amountMinor)), basis: input.basis, note: input.note ?? null });
  return recomputeLandedCost(ctx, poId);
}

export async function deletePoCharge(ctx: ServiceContext, poId: string, chargeId: string) {
  await ctx.tx.delete(schema.purchaseOrderCharges).where(and(eq(schema.purchaseOrderCharges.tenantId, ctx.tenantId), eq(schema.purchaseOrderCharges.id, chargeId)));
  return recomputeLandedCost(ctx, poId);
}

/* ---------- supplier send & confirmation ---------- */

/**
 * Marks the PO as sent to the supplier with a fresh confirmation link (the previous one is
 * revoked); returns the token, which is shown once and stored only as a hash.
 */
export async function issueSupplierToken(ctx: ServiceContext, poId: string, email: string | null): Promise<string> {
  return (await issueSupplierLink(ctx, poId, email)).token;
}

/* ---------- cash flow ---------- */

export interface CashFlowReport {
  items: (CashOut & { supplierName: string | null; planned: boolean })[];
  byMonth: { month: string; amountMinor: number; cumulativeMinor: number; committedMinor: number; plannedMinor: number }[];
  committedMinor: number;
  plannedMinor: number;
}

/**
 * Money leaving for purchases: open POs (what is still unpaid of deposit and balance, by supplier
 * terms) plus the current reorder suggestions as if ordered today.
 */
export async function cashFlowPlan(ctx: ServiceContext, tenant: PlanningTenant, opts: { includePlan?: boolean } = {}): Promise<CashFlowReport> {
  const today = ctx.now ?? new Date();
  const suppliers = await ctx.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenantId));
  const sup = new Map(suppliers.map((s) => [s.id, s]));
  const pos = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), inArray(schema.purchaseOrders.status, ["draft", "sent", "confirmed", "in_transit", "partially_received", "received"])));
  const paid = await ctx.tx.select({ po: schema.supplierPayments.purchaseOrderId, amount: sql<number>`coalesce(sum(${schema.supplierPayments.amountMinor}),0)::int` }).from(schema.supplierPayments).where(eq(schema.supplierPayments.tenantId, ctx.tenantId)).groupBy(schema.supplierPayments.purchaseOrderId);
  const paidBy = new Map(paid.map((p) => [p.po, p.amount]));
  const items: CashFlowReport["items"] = [];
  for (const po of pos) {
    const s = sup.get(po.supplierId);
    const outstanding = po.totalMinor - (paidBy.get(po.id) ?? 0);
    if (outstanding <= 0) continue;
    const orderDate = po.orderedAt ?? today;
    const expected = po.expectedAt ?? new Date(orderDate.getTime() + (s?.leadTimeDays ?? 21) * 864e5);
    const leadTimeDays = Math.max(0, Math.round((expected.getTime() - orderDate.getTime()) / 864e5));
    const sched = cashOutSchedule([{ ref: po.number, orderDate: orderDate < today ? today : orderDate, leadTimeDays: po.receivedAt ? 0 : Math.max(0, Math.round((expected.getTime() - Math.max(orderDate.getTime(), today.getTime())) / 864e5)), totalMinor: outstanding, terms: { depositShare: po.status === "draft" ? (s?.depositBps ?? 0) / 10000 : 0, balanceDaysAfterReceipt: po.receivedAt ? Math.max(0, (s?.balanceDays ?? 30) - Math.round((today.getTime() - po.receivedAt.getTime()) / 864e5)) : (s?.balanceDays ?? 30) } }]);
    void leadTimeDays;
    for (const c of sched) items.push({ ...c, supplierName: s?.name ?? null, planned: po.status === "draft" });
  }
  if (opts.includePlan !== false) {
    const plan = (await replenishmentPlan(ctx, tenant, { onlyToOrder: true })).filter((r) => r.inDraft === 0 && r.costMinor);
    const bySupplier = new Map<string, { total: number; lead: number }>();
    for (const r of plan) {
      const k = r.supplierId ?? "none";
      const cur = bySupplier.get(k) ?? { total: 0, lead: 0 };
      bySupplier.set(k, { total: cur.total + (r.costMinor ?? 0), lead: Math.max(cur.lead, r.leadTimeDays) });
    }
    for (const [k, v] of bySupplier) {
      const s = sup.get(k);
      for (const c of cashOutSchedule([{ ref: `plan:${s?.name ?? "—"}`, orderDate: today, leadTimeDays: v.lead, totalMinor: v.total, terms: { depositShare: (s?.depositBps ?? 0) / 10000, balanceDaysAfterReceipt: s?.balanceDays ?? 30 } }])) items.push({ ...c, supplierName: s?.name ?? null, planned: true });
    }
  }
  items.sort((a, b) => (a.date < b.date ? -1 : 1));
  const byMonthBase = cashOutByMonth(items);
  const byMonth = byMonthBase.map((m) => ({ ...m, committedMinor: items.filter((i) => !i.planned && i.date.startsWith(m.month)).reduce((s, i) => s + i.amountMinor, 0), plannedMinor: items.filter((i) => i.planned && i.date.startsWith(m.month)).reduce((s, i) => s + i.amountMinor, 0) }));
  return { items, byMonth, committedMinor: items.filter((i) => !i.planned).reduce((s, i) => s + i.amountMinor, 0), plannedMinor: items.filter((i) => i.planned).reduce((s, i) => s + i.amountMinor, 0) };
}

/* ---------- stock analysis ---------- */

export interface StockAnalysisReportRow extends StockAnalysisRow {
  label: string;
  productId: string;
  sku: string | null;
  onHand: number;
  revenueMinor: number;
  stockoutDate: string | null;
}

export async function stockAnalysisReport(ctx: ServiceContext, tenant: PlanningTenant): Promise<{ rows: StockAnalysisReportRow[]; matrix: Record<string, { count: number; valueMinor: number }>; totalValueMinor: number; excessValueMinor: number; slowValueMinor: number }> {
  const variants = await variantsOf(ctx);
  const ids = variants.map((v) => v.id);
  const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, ctx.tenantId)).groupBy(schema.inventoryLevels.variantId);
  const lv = new Map(levels.map((l) => [l.variantId, l.available]));
  const weekly = await ctx.tx.execute<{ variant_id: string; week: number; units: number; revenue: number }>(sql`
    select l.variant_id, floor(extract(epoch from (now() - o.placed_at)) / 604800)::int as week, sum(l.current_quantity)::int as units, sum(l.total_minor)::bigint as revenue
    from order_lines l join orders o on o.id = l.order_id
    where o.tenant_id = ${ctx.tenantId} and o.status in ${sql.raw(SALE)} and l.variant_id is not null and o.placed_at >= now() - interval '52 weeks'
    group by 1, 2`);
  const per = new Map<string, { weeks: number[]; revenue: number }>();
  for (const r of weekly.rows) {
    // variability on 13 four-week buckets: weekly buckets are too sparse per variant and make almost everything "Z"
    const cur = per.get(r.variant_id) ?? { weeks: Array(13).fill(0), revenue: 0 };
    const bucket = Math.floor(Number(r.week) / 4);
    if (bucket < 13) cur.weeks[bucket] += Number(r.units);
    cur.revenue += Number(r.revenue);
    per.set(r.variant_id, cur);
  }
  const stats = await dailyStats(ctx, tenant.timezone, 90, ids);
  const today = ctx.now ?? new Date();
  const items = variants.map((v) => ({ id: v.id, revenueMinor: per.get(v.id)?.revenue ?? 0, periodUnits: per.get(v.id)?.weeks ?? Array(13).fill(0), onHand: lv.get(v.id) ?? 0, unitCostMinor: v.costMinor ?? 0, dailyMean: stats.get(v.id)?.mean ?? 0 }));
  const analysed = stockAnalysis(items, { maxCoverDays: tenant.settings.excessCoverDays, slowCoverDays: tenant.settings.slowCoverDays });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const rows = analysed.map((r) => {
    const v = byId.get(r.id)!;
    const it = items.find((i) => i.id === r.id)!;
    const so = stockoutDate(it.onHand, it.dailyMean, today);
    return { ...r, label: `${v.productTitle} ${v.title}`.trim(), productId: v.productId, sku: v.sku, onHand: it.onHand, revenueMinor: it.revenueMinor, stockoutDate: so.date ? so.date.toISOString().slice(0, 10) : null };
  });
  const matrix: Record<string, { count: number; valueMinor: number }> = {};
  for (const r of rows) {
    const k = `${r.abc}${r.xyz}`;
    matrix[k] = { count: (matrix[k]?.count ?? 0) + 1, valueMinor: (matrix[k]?.valueMinor ?? 0) + r.stockValueMinor };
  }
  const unitCost = new Map(items.map((i) => [i.id, i.unitCostMinor]));
  return {
    rows,
    matrix,
    totalValueMinor: rows.reduce((s, r) => s + r.stockValueMinor, 0),
    excessValueMinor: rows.reduce((s, r) => s + r.excessUnits * (unitCost.get(r.id) ?? 0), 0),
    slowValueMinor: rows.filter((r) => r.slowMover).reduce((s, r) => s + r.stockValueMinor, 0),
  };
}

/* ---------- multi-location transfers ---------- */

export interface TransferRow {
  variantId: string;
  label: string;
  sku: string | null;
  from: { id: string; name: string };
  to: { id: string; name: string };
  units: number;
}

export async function transferPlan(ctx: ServiceContext, tenant: PlanningTenant): Promise<TransferRow[]> {
  const locations = await ctx.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isActive, true)));
  if (locations.length < 2) return [];
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const levels = await ctx.tx.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, ctx.tenantId));
  // demand by location: sales are not tagged by location, so split the variant's pace in proportion to each location's share of the last 90 days of stock movements out (fallback: equal)
  const variants = await variantsOf(ctx);
  const stats = await dailyStats(ctx, tenant.timezone, 90);
  const out: TransferRow[] = [];
  const byVariant = new Map<string, typeof levels>();
  for (const l of levels) {
    const arr = byVariant.get(l.variantId) ?? [];
    arr.push(l);
    byVariant.set(l.variantId, arr);
  }
  const weights = new Map(locations.map((l) => [l.id, l.isDefault ? 0.6 : 0.4 / Math.max(1, locations.length - 1)]));
  for (const v of variants) {
    const ls = byVariant.get(v.id) ?? [];
    if (ls.length < 2) continue;
    const mean = stats.get(v.id)?.mean ?? 0;
    if (mean <= 0) continue;
    const moves = transferSuggestions(ls.map((l) => ({ locationId: l.locationId, available: l.available, dailyMean: mean * (weights.get(l.locationId) ?? 0.5) })), { shortDays: tenant.settings.transferShortDays, surplusDays: tenant.settings.transferSurplusDays });
    for (const m of moves) out.push({ variantId: v.id, label: `${v.productTitle} ${v.title}`.trim(), sku: v.sku, from: { id: m.from, name: locName.get(m.from) ?? "—" }, to: { id: m.to, name: locName.get(m.to) ?? "—" }, units: m.units });
  }
  return out.sort((a, b) => b.units - a.units);
}

/**
 * Moves stock between two locations: local levels and two movements, plus (with `pushToPlatform`)
 * both new quantities enqueued as outbox writes in the same transaction. The caller dispatches the
 * returned writes once committed.
 */
export async function applyTransfer(ctx: ServiceContext, input: { variantId: string; fromLocationId: string; toLocationId: string; units: number }, opts: { pushToPlatform?: boolean } = {}) {
  const units = Math.max(0, Math.floor(input.units));
  if (!units || input.fromLocationId === input.toLocationId) throw new Error("invalid_input");
  const lv = await ctx.tx.select({ l: schema.inventoryLevels, locExt: schema.locations.externalId, invExt: schema.productVariants.inventoryItemExternalId }).from(schema.inventoryLevels).innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId)).innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId)).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), eq(schema.inventoryLevels.variantId, input.variantId), inArray(schema.inventoryLevels.locationId, [input.fromLocationId, input.toLocationId])));
  const from = lv.find((x) => x.l.locationId === input.fromLocationId);
  const to = lv.find((x) => x.l.locationId === input.toLocationId);
  if (!from || from.l.available < units) throw new Error("insufficient_stock");
  const newFrom = from.l.available - units;
  const newTo = (to?.l.available ?? 0) + units;
  const writes: PlatformWriteRow[] = [];
  if (opts.pushToPlatform && from.invExt && from.locExt) {
    writes.push(await enqueuePlatformWrite(ctx, { kind: "inventory.set", entityType: "variant", entityId: input.variantId, payload: { inventoryItemExternalId: from.invExt, locationExternalId: from.locExt, available: newFrom } }));
    const [toLoc] = await ctx.tx.select({ ext: schema.locations.externalId }).from(schema.locations).where(eq(schema.locations.id, input.toLocationId)).limit(1);
    if (toLoc?.ext) writes.push(await enqueuePlatformWrite(ctx, { kind: "inventory.set", entityType: "variant", entityId: input.variantId, payload: { inventoryItemExternalId: from.invExt, locationExternalId: toLoc.ext, available: newTo } }));
  }
  await ctx.tx.update(schema.inventoryLevels).set({ available: newFrom, onHand: Math.max(0, (from.l.onHand ?? from.l.available) - units) }).where(eq(schema.inventoryLevels.id, from.l.id));
  if (to) await ctx.tx.update(schema.inventoryLevels).set({ available: newTo, onHand: (to.l.onHand ?? to.l.available) + units }).where(eq(schema.inventoryLevels.id, to.l.id));
  else await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: input.variantId, locationId: input.toLocationId, available: units, onHand: units, committed: 0 });
  const ref = { referenceType: "transfer", referenceId: null, actorUserId: ctx.actor.userId };
  await ctx.tx.insert(schema.inventoryMovements).values([{ tenantId: ctx.tenantId, variantId: input.variantId, locationId: input.fromLocationId, delta: -units, reason: "transfer_out", ...ref }, { tenantId: ctx.tenantId, variantId: input.variantId, locationId: input.toLocationId, delta: units, reason: "transfer_in", ...ref }]);
  return { from: newFrom, to: newTo, writes };
}

/* ---------- revenue target ---------- */

export interface TargetPlanRow {
  variantId: string;
  label: string;
  sku: string | null;
  forecastUnits: number;
  plannedUnits: number;
  plannedRevenueMinor: number;
  stockUnits: number;
  gapUnits: number;
  gapCostMinor: number;
}

/** Stock needed per SKU to reach a revenue target over the next `months`, scaling the forecast mix. */
export async function revenueTargetPlan(ctx: ServiceContext, tenant: PlanningTenant, targetMinor: number, months: number): Promise<{ rows: TargetPlanRow[]; forecastRevenueMinor: number; gapCostMinor: number }> {
  const fc = await forecastVariants(ctx, tenant, { horizon: months });
  const variants = new Map((await variantsOf(ctx)).map((v) => [v.id, v]));
  const skus = fc.map((f) => ({ id: f.variantId, forecastUnits: f.forecast.reduce((s, p) => s + p.units, 0), priceMinor: variants.get(f.variantId)?.priceMinor ?? 0 })).filter((k) => k.forecastUnits > 0);
  const plan = planFromRevenueTarget(targetMinor, skus);
  const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, ctx.tenantId)).groupBy(schema.inventoryLevels.variantId);
  const incoming = await ctx.tx.select({ variantId: schema.purchaseOrderLines.variantId, n: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}),0)::int` }).from(schema.purchaseOrderLines).innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId)).where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), inArray(schema.purchaseOrders.status, ["sent", "confirmed", "in_transit", "partially_received"]))).groupBy(schema.purchaseOrderLines.variantId);
  const stock = new Map(levels.map((l) => [l.variantId, l.available]));
  for (const i of incoming) if (i.variantId) stock.set(i.variantId, (stock.get(i.variantId) ?? 0) + i.n);
  const rows = plan.map((p) => {
    const v = variants.get(p.id);
    const s = Math.max(0, stock.get(p.id) ?? 0);
    const gap = Math.max(0, p.units - s);
    return { variantId: p.id, label: v ? `${v.productTitle} ${v.title}`.trim() : p.id, sku: v?.sku ?? null, forecastUnits: skus.find((k) => k.id === p.id)?.forecastUnits ?? 0, plannedUnits: p.units, plannedRevenueMinor: p.revenueMinor, stockUnits: s, gapUnits: gap, gapCostMinor: gap * (v?.costMinor ?? 0) };
  });
  return { rows: rows.sort((a, b) => b.gapCostMinor - a.gapCostMinor), forecastRevenueMinor: skus.reduce((s, k) => s + k.forecastUnits * k.priceMinor, 0), gapCostMinor: rows.reduce((s, r) => s + r.gapCostMinor, 0) };
}

/* ---------- bundles and bills of materials ---------- */

export interface BundleRow {
  parentVariantId: string;
  label: string;
  kind: "bundle" | "bom";
  available: number;
  components: { variantId: string; label: string; quantity: number; available: number }[];
}

export async function bundleReport(ctx: ServiceContext): Promise<BundleRow[]> {
  const comps = await ctx.tx.select().from(schema.bundleComponents).where(eq(schema.bundleComponents.tenantId, ctx.tenantId));
  if (!comps.length) return [];
  const ids = [...new Set(comps.flatMap((c) => [c.parentVariantId, c.componentVariantId]))];
  const info = new Map((await variantsOf(ctx, { variantIds: ids })).map((v) => [v.id, v]));
  const all = await ctx.tx.select({ id: schema.productVariants.id, title: schema.productVariants.title, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(inArray(schema.productVariants.id, ids));
  const label = (id: string) => {
    const v = info.get(id) ?? all.find((a) => a.id === id);
    return v ? `${"productTitle" in v ? v.productTitle : v.product} ${v.title}`.trim() : id;
  };
  const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, ids))).groupBy(schema.inventoryLevels.variantId);
  const lv = new Map(levels.map((l) => [l.variantId, l.available]));
  const parents = new Map<string, typeof comps>();
  for (const c of comps) parents.set(c.parentVariantId, [...(parents.get(c.parentVariantId) ?? []), c]);
  return [...parents].map(([pid, cs]) => {
    const components = cs.map((c) => ({ variantId: c.componentVariantId, label: label(c.componentVariantId), quantity: c.quantity, available: lv.get(c.componentVariantId) ?? 0 }));
    return { parentVariantId: pid, label: label(pid), kind: (cs[0]!.kind as "bundle" | "bom") ?? "bundle", available: bundleAvailability(components.map((c) => ({ available: c.available, quantityPerUnit: c.quantity }))), components };
  });
}

/** Material requirements for the next `months` of forecast of finished goods with a bill of materials, against material stock. */
export async function materialRequirements(ctx: ServiceContext, tenant: PlanningTenant, months = 3): Promise<{ variantId: string; label: string; requiredUnits: number; availableUnits: number; shortfall: number }[]> {
  const comps = await ctx.tx.select().from(schema.bundleComponents).where(and(eq(schema.bundleComponents.tenantId, ctx.tenantId), eq(schema.bundleComponents.kind, "bom")));
  if (!comps.length) return [];
  const bom = new Map<string, { componentId: string; quantity: number }[]>();
  for (const c of comps) bom.set(c.parentVariantId, [...(bom.get(c.parentVariantId) ?? []), { componentId: c.componentVariantId, quantity: c.quantity }]);
  const parents = [...bom.keys()];
  const fc = await forecastVariants(ctx, tenant, { variantIds: parents, horizon: months });
  const need = new Map<string, number>();
  for (const f of fc) for (const [k, v] of explodeBom(f.variantId, f.forecast.reduce((s, p) => s + p.units, 0), bom)) need.set(k, (need.get(k) ?? 0) + v);
  const ids = [...need.keys()];
  if (!ids.length) return [];
  const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, ids))).groupBy(schema.inventoryLevels.variantId);
  const lv = new Map(levels.map((l) => [l.variantId, l.available]));
  const names = await ctx.tx.select({ id: schema.productVariants.id, title: schema.productVariants.title, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(inArray(schema.productVariants.id, ids));
  return ids.map((id) => {
    const n = names.find((x) => x.id === id);
    const required = need.get(id) ?? 0;
    const available = lv.get(id) ?? 0;
    return { variantId: id, label: n ? `${n.product} ${n.title}`.trim() : id, requiredUnits: required, availableUnits: available, shortfall: Math.max(0, required - available) };
  }).sort((a, b) => b.shortfall - a.shortfall);
}

export async function saveBundleComponent(ctx: ServiceContext, input: { parentVariantId: string; componentVariantId: string; quantity: number; kind: "bundle" | "bom" }) {
  if (input.parentVariantId === input.componentVariantId) throw new Error("invalid_input");
  await ctx.tx.insert(schema.bundleComponents).values({ tenantId: ctx.tenantId, parentVariantId: input.parentVariantId, componentVariantId: input.componentVariantId, quantity: Math.max(1, Math.round(input.quantity)), kind: input.kind }).onConflictDoUpdate({ target: [schema.bundleComponents.tenantId, schema.bundleComponents.parentVariantId, schema.bundleComponents.componentVariantId], set: { quantity: Math.max(1, Math.round(input.quantity)), kind: input.kind } });
}

export async function deleteBundleComponent(ctx: ServiceContext, parentVariantId: string, componentVariantId: string) {
  await ctx.tx.delete(schema.bundleComponents).where(and(eq(schema.bundleComponents.tenantId, ctx.tenantId), eq(schema.bundleComponents.parentVariantId, parentVariantId), eq(schema.bundleComponents.componentVariantId, componentVariantId)));
}


export * from "./supplier";
