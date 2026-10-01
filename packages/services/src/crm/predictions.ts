import { and, desc, eq, schema, sql } from "@keel/db";
import { CHURN_RISKS, SALE_STATUSES, churnThresholdsFromPct, runPredictionModel, type CalibrationReport, type ChurnRisk, type CustomerHistory, type GammaGammaParams, type MbgParams } from "@keel/core";
import type { ServiceContext } from "../context";

const SALE = SALE_STATUSES as readonly string[];
const DAY = 864e5;

/** Sale-scope orders of every customer (same scope as the P/L and the customer profile). */
async function loadHistories(ctx: ServiceContext): Promise<CustomerHistory[]> {
  const rows = await ctx.tx.execute<{ customer_id: string; placed_at: string | Date; total_minor: number }>(sql`
    select customer_id, placed_at, total_minor from orders
    where tenant_id = ${ctx.tenantId} and customer_id is not null and status in ${SALE}
    order by customer_id, placed_at`);
  const map = new Map<string, CustomerHistory>();
  for (const r of rows.rows) {
    let h = map.get(r.customer_id);
    if (!h) {
      h = { customerId: r.customer_id, orders: [] };
      map.set(r.customer_id, h);
    }
    h.orders.push({ at: new Date(r.placed_at), valueMinor: Number(r.total_minor) });
  }
  return [...map.values()];
}

export interface StoredCalibration {
  cutoff: string;
  end: string;
  customers: number;
  predicted: number;
  actual: number;
  error: number | null;
  rows: { repeat: number; customers: number; predicted: number; actual: number }[];
}

function storeCalibration(c: CalibrationReport | null): StoredCalibration | null {
  return c ? { ...c, cutoff: c.cutoff.toISOString(), end: c.end.toISOString() } : null;
}

export interface PredictionRunResult {
  status: "ok" | "insufficient_data";
  customers: number;
  durationMs: number;
}

/**
 * Fits the tenant's model and replaces every stored prediction. Customers without a sale
 * order lose their row, so a prediction never outlives the data it came from.
 */
export async function recomputePredictions(ctx: ServiceContext, settings: { churnLowPct: number; churnMediumPct: number }): Promise<PredictionRunResult> {
  const started = Date.now();
  const now = ctx.now ?? new Date();
  const histories = await loadHistories(ctx);
  const run = runPredictionModel(histories, now, { thresholds: churnThresholdsFromPct(settings.churnLowPct, settings.churnMediumPct) });
  await ctx.tx.delete(schema.customerPredictions).where(eq(schema.customerPredictions.tenantId, ctx.tenantId));
  const rows = run.predictions.map((p) => ({
    tenantId: ctx.tenantId,
    customerId: p.customerId,
    pAlive: p.pAlive,
    expectedOrders90: p.expectedOrders90,
    expectedOrders365: p.expectedOrders365,
    expectedOrderValueMinor: p.expectedOrderValueMinor,
    predictedValue365Minor: p.predictedValue365Minor,
    churnRisk: p.churnRisk,
    nextOrderAt: p.nextOrderAt,
    computedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 1000) await ctx.tx.insert(schema.customerPredictions).values(rows.slice(i, i + 1000));
  const durationMs = Date.now() - started;
  const model = {
    tenantId: ctx.tenantId,
    status: run.model ? "ok" : "insufficient_data",
    params: run.model ? { mbg: run.model.mbg, gammaGamma: run.model.gammaGamma, meanOrderValueMinor: run.model.meanOrderValueMinor, medianDaysToSecond: run.model.medianDaysToSecond } : null,
    customers: run.model?.customers ?? histories.length,
    logLikelihood: run.model?.logLikelihood ?? null,
    calibration: storeCalibration(run.calibration),
    durationMs,
    fittedAt: now,
  };
  await ctx.tx.insert(schema.customerPredictionModels).values(model).onConflictDoUpdate({ target: schema.customerPredictionModels.tenantId, set: { ...model } });
  return { status: run.model ? "ok" : "insufficient_data", customers: rows.length, durationMs };
}

export interface PredictionModelInfo {
  status: "ok" | "insufficient_data";
  fittedAt: Date;
  customers: number;
  durationMs: number | null;
  params: { mbg: MbgParams; gammaGamma: GammaGammaParams | null; meanOrderValueMinor: number; medianDaysToSecond: number | null } | null;
  calibration: StoredCalibration | null;
}

export interface PredictionListRow {
  customerId: string;
  name: string;
  email: string | null;
  ordersCount: number;
  totalSpentMinor: number;
  lastOrderAt: Date | null;
  pAlive: number;
  churnRisk: ChurnRisk;
  expectedOrders365: number;
  predictedValue365Minor: number;
  nextOrderAt: Date | null;
}

export interface PredictionOverview {
  model: PredictionModelInfo | null;
  byRisk: { risk: ChurnRisk; customers: number; historicalMinor: number; predictedMinor: number }[];
  expectedOrders90: number;
  expectedOrders365: number;
  predictedValue365Minor: number;
  /** High historical value, medium or high churn risk: the win-back list. */
  slipping: PredictionListRow[];
  /** Expected to order within the next 14 days and still active. */
  dueSoon: PredictionListRow[];
  /** Highest predicted value over the next year. */
  top: PredictionListRow[];
}

type ListSqlRow = { customer_id: string; first_name: string | null; last_name: string | null; email: string | null; orders_count: number; total_spent: number; last_order_at: string | Date | null; p_alive: number; churn_risk: string; expected_orders_365: number; predicted_value_365_minor: number; next_order_at: string | Date | null };

function toListRow(r: ListSqlRow): PredictionListRow {
  return {
    customerId: r.customer_id,
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.customer_id.slice(0, 8),
    email: r.email,
    ordersCount: Number(r.orders_count),
    totalSpentMinor: Number(r.total_spent),
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at) : null,
    pAlive: Number(r.p_alive),
    churnRisk: r.churn_risk as ChurnRisk,
    expectedOrders365: Number(r.expected_orders_365),
    predictedValue365Minor: Number(r.predicted_value_365_minor),
    nextOrderAt: r.next_order_at ? new Date(r.next_order_at) : null,
  };
}

export async function predictionModelInfo(ctx: ServiceContext): Promise<PredictionModelInfo | null> {
  const [m] = await ctx.tx.select().from(schema.customerPredictionModels).where(eq(schema.customerPredictionModels.tenantId, ctx.tenantId)).limit(1);
  if (!m) return null;
  return { status: m.status as PredictionModelInfo["status"], fittedAt: m.fittedAt, customers: m.customers, durationMs: m.durationMs, params: (m.params as PredictionModelInfo["params"]) ?? null, calibration: (m.calibration as StoredCalibration | null) ?? null };
}

export async function predictionOverview(ctx: ServiceContext, listSize = 15): Promise<PredictionOverview> {
  const now = ctx.now ?? new Date();
  const t = ctx.tenantId;
  const model = await predictionModelInfo(ctx);
  const agg = await ctx.tx.execute<{ churn_risk: string; customers: number; historical: number; predicted: number; e90: number; e365: number }>(sql`
    select cp.churn_risk, count(*)::int as customers, coalesce(sum(c.total_spent_minor), 0)::float8 as historical, coalesce(sum(cp.predicted_value_365_minor), 0)::float8 as predicted,
      coalesce(sum(cp.expected_orders_90), 0)::float8 as e90, coalesce(sum(cp.expected_orders_365), 0)::float8 as e365
    from customer_predictions cp join customers c on c.id = cp.customer_id
    where cp.tenant_id = ${t} group by cp.churn_risk`);
  const byRisk = CHURN_RISKS.map((risk) => {
    const r = agg.rows.find((x) => x.churn_risk === risk);
    return { risk, customers: r ? Number(r.customers) : 0, historicalMinor: r ? Number(r.historical) : 0, predictedMinor: r ? Number(r.predicted) : 0 };
  });
  const sum = (k: "e90" | "e365" | "predicted") => agg.rows.reduce((s, r) => s + Number(r[k]), 0);
  // historical value from sale orders, same scope as the profile
  const base = sql`
    select cp.customer_id, c.first_name, c.last_name, c.email, s.orders_count, s.total_spent, s.last_order_at,
      cp.p_alive, cp.churn_risk, cp.expected_orders_365, cp.predicted_value_365_minor, cp.next_order_at
    from customer_predictions cp
    join customers c on c.id = cp.customer_id
    join (select customer_id, count(*)::int as orders_count, sum(total_minor)::float8 as total_spent, max(placed_at) as last_order_at
          from orders where tenant_id = ${t} and customer_id is not null and status in ${SALE} group by customer_id) s on s.customer_id = cp.customer_id
    where cp.tenant_id = ${t}`;
  const slipping = await ctx.tx.execute<ListSqlRow>(sql`${base} and cp.churn_risk in ('medium', 'high') and s.orders_count >= 2 order by s.total_spent desc, cp.customer_id limit ${listSize}`);
  const dueSoon = await ctx.tx.execute<ListSqlRow>(sql`${base} and cp.next_order_at between ${new Date(now.getTime() - 7 * DAY)} and ${new Date(now.getTime() + 14 * DAY)} order by cp.next_order_at, cp.customer_id limit ${listSize}`);
  const top = await ctx.tx.execute<ListSqlRow>(sql`${base} order by cp.predicted_value_365_minor desc, cp.customer_id limit ${listSize}`);
  return {
    model,
    byRisk,
    expectedOrders90: sum("e90"),
    expectedOrders365: sum("e365"),
    predictedValue365Minor: sum("predicted"),
    slipping: slipping.rows.map(toListRow),
    dueSoon: dueSoon.rows.map(toListRow),
    top: top.rows.map(toListRow),
  };
}

export interface CustomerPredictionView {
  pAlive: number;
  churnRisk: ChurnRisk;
  expectedOrders90: number;
  expectedOrders365: number;
  expectedOrderValueMinor: number;
  predictedValue365Minor: number;
  nextOrderAt: Date | null;
  computedAt: Date;
}

export async function customerPrediction(ctx: ServiceContext, customerId: string): Promise<CustomerPredictionView | null> {
  const [p] = await ctx.tx.select().from(schema.customerPredictions).where(and(eq(schema.customerPredictions.tenantId, ctx.tenantId), eq(schema.customerPredictions.customerId, customerId))).orderBy(desc(schema.customerPredictions.computedAt)).limit(1);
  if (!p) return null;
  return { pAlive: p.pAlive, churnRisk: p.churnRisk as ChurnRisk, expectedOrders90: p.expectedOrders90, expectedOrders365: p.expectedOrders365, expectedOrderValueMinor: p.expectedOrderValueMinor, predictedValue365Minor: p.predictedValue365Minor, nextOrderAt: p.nextOrderAt, computedAt: p.computedAt };
}
