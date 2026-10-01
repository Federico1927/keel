import { eq, schema, sql } from "@keel/db";
import { cacPaybackDays, cohortLtv, pairLift, type CustomerTimeline, type LtvCohortRow } from "@keel/core";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "./index";

const SALE = "('confirmed','fulfilling','shipped','delivered','returned_partial')";

/**
 * One timeline per customer: every sale order with net revenue (total − tax − refunds) and margin
 * (net − cost of goods from the line cost snapshot), plus the keys the LTV tab groups by:
 * first-order month, first-order attribution channel, first product bought.
 */
export async function customerTimelines(ctx: ServiceContext, tenant: AnalyticsTenant, months = 18): Promise<CustomerTimeline[]> {
  const rows = await ctx.tx.execute<{ customer_id: string; order_id: string; placed_at: string; net: number; margin: number; cohort: string; channel: string | null; first_product: string | null; first_order_id: string }>(sql`
    with sales as (
      select o.id, o.customer_id, o.placed_at,
             (o.total_minor - o.tax_minor - o.refunded_minor)::int as net,
             (o.total_minor - o.tax_minor - o.refunded_minor - coalesce((select sum(l.current_quantity * coalesce(l.unit_cost_minor, 0)) from order_lines l where l.order_id = o.id), 0))::int as margin
      from orders o
      where o.tenant_id = ${ctx.tenantId} and o.customer_id is not null and o.status in ${sql.raw(SALE)}
    ), firsts as (
      select distinct on (customer_id) customer_id, id as first_order_id, placed_at as first_at from sales order by customer_id, placed_at asc, id asc
    ), first_products as (
      select distinct on (l.order_id) l.order_id, p.title from order_lines l join products p on p.id = l.product_id
      where l.order_id in (select first_order_id from firsts) and not l.is_ancillary order by l.order_id, l.total_minor desc
    )
    select s.customer_id, s.id as order_id, s.placed_at, s.net, s.margin,
           to_char(f.first_at at time zone ${tenant.timezone}, 'YYYY-MM') as cohort,
           a.channel, fp.title as first_product, f.first_order_id
    from sales s
    join firsts f on f.customer_id = s.customer_id
    left join order_attribution a on a.order_id = f.first_order_id
    left join first_products fp on fp.order_id = f.first_order_id
    where f.first_at >= date_trunc('month', now() at time zone ${tenant.timezone}) - make_interval(months => ${months})
    order by s.customer_id, s.placed_at`);
  const map = new Map<string, CustomerTimeline>();
  for (const r of rows.rows) {
    const c = map.get(r.customer_id) ?? { customerId: r.customer_id, keys: { cohort: r.cohort, channel: r.channel ?? "unknown", product: r.first_product ?? "—" }, orders: [] };
    c.orders.push({ at: new Date(r.placed_at), netMinor: Number(r.net), marginMinor: Number(r.margin) });
    map.set(r.customer_id, c);
  }
  return [...map.values()];
}

export interface LtvReportRow extends LtvCohortRow {
  cacMinor: number | null;
  paybackDays: number | null;
}

/** LTV by cohort month, acquisition channel or first product; CAC and payback only make sense by month. */
export async function ltvReport(ctx: ServiceContext, tenant: AnalyticsTenant, by: "cohort" | "channel" | "product", months = 18): Promise<LtvReportRow[]> {
  const timelines = await customerTimelines(ctx, tenant, months);
  const rows = cohortLtv(timelines, by, ctx.now ?? new Date());
  const limited = by === "product" ? rows.sort((a, b) => b.customers - a.customers).slice(0, 25) : rows;
  if (by !== "cohort") return limited.map((r) => ({ ...r, cacMinor: null, paybackDays: null }));
  const spend = await ctx.tx.select({ month: sql<string>`substr(${schema.adMetricsDaily.date}, 1, 7)`, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(eq(schema.adMetricsDaily.tenantId, ctx.tenantId)).groupBy(sql`1`);
  const spendByMonth = new Map(spend.map((s) => [s.month, s.spend]));
  return limited.map((r) => {
    const cacMinor = r.customers > 0 && (spendByMonth.get(r.key) ?? 0) > 0 ? Math.round((spendByMonth.get(r.key) ?? 0) / r.customers) : null;
    return { ...r, cacMinor, paybackDays: cacPaybackDays(r.windows, cacMinor) };
  });
}

/* ---------- product analysis ---------- */

export interface EntryProductRow {
  productId: string;
  title: string;
  customers: number;
  /** Average 365-day net value of customers acquired with this product (matured ones). */
  avgLtv365Minor: number | null;
  matured: number;
  repeatRate: number | null;
}

/** Which first product brings the customers who come back and spend more. */
export async function entryProducts(ctx: ServiceContext, tenant: AnalyticsTenant, limit = 20): Promise<EntryProductRow[]> {
  const timelines = await customerTimelines(ctx, tenant, 24);
  const rows = cohortLtv(timelines, "product", ctx.now ?? new Date(), [365]);
  const titles = await ctx.tx.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenantId));
  return rows
    .filter((r) => r.key !== "—")
    .sort((a, b) => b.customers - a.customers)
    .slice(0, limit)
    .map((r) => {
      const w = r.windows[0]!;
      return { productId: titles.find((t) => t.title === r.key)?.id ?? "", title: r.key, customers: r.customers, avgLtv365Minor: w.avgNetMinor, matured: w.matured, repeatRate: w.repeatRate };
    });
}

export interface PairRow {
  a: { id: string; title: string };
  b: { id: string; title: string };
  orders: number;
  lift: number | null;
}

/** Product pairs that appear in the same sale order, with support and lift, over a period. */
export async function boughtTogether(ctx: ServiceContext, period: { from: Date; to: Date }, limit = 20): Promise<PairRow[]> {
  const rows = await ctx.tx.execute<{ a: string; a_title: string; b: string; b_title: string; both: number; n_a: number; n_b: number; total: number }>(sql`
    with o as (
      select id from orders where tenant_id = ${ctx.tenantId} and placed_at >= ${period.from} and placed_at < ${period.to} and status in ${sql.raw(SALE)}
    ), lines as (
      select distinct l.order_id, l.product_id from order_lines l join o on o.id = l.order_id where l.product_id is not null and not l.is_ancillary
    ), per_product as (
      select product_id, count(*)::int as n from lines group by product_id
    ), pairs as (
      select x.product_id as a, y.product_id as b, count(*)::int as both
      from lines x join lines y on y.order_id = x.order_id and y.product_id > x.product_id
      group by 1, 2 having count(*) >= 3
    )
    select p.a, pa.title as a_title, p.b, pb.title as b_title, p.both, na.n as n_a, nb.n as n_b, (select count(*) from o)::int as total
    from pairs p
    join per_product na on na.product_id = p.a join per_product nb on nb.product_id = p.b
    join products pa on pa.id = p.a join products pb on pb.id = p.b
    order by p.both desc limit ${limit}`);
  return rows.rows.map((r) => ({ a: { id: r.a, title: r.a_title }, b: { id: r.b, title: r.b_title }, orders: Number(r.both), lift: pairLift(Number(r.n_a), Number(r.n_b), Number(r.both), Number(r.total)) }));
}

export interface PathRow {
  first: { id: string; title: string };
  second: { id: string; title: string };
  customers: number;
  medianDays: number | null;
}

/** First → second purchase: the most frequent transitions between main products. */
export async function secondPurchasePaths(ctx: ServiceContext, limit = 20): Promise<PathRow[]> {
  const rows = await ctx.tx.execute<{ f: string; f_title: string; s: string; s_title: string; n: number; med: number | null }>(sql`
    with sales as (
      select o.id, o.customer_id, o.placed_at, row_number() over (partition by o.customer_id order by o.placed_at, o.id) as rn
      from orders o where o.tenant_id = ${ctx.tenantId} and o.customer_id is not null and o.status in ${sql.raw(SALE)}
    ), mains as (
      select distinct on (l.order_id) l.order_id, l.product_id from order_lines l join sales s on s.id = l.order_id
      where l.product_id is not null and not l.is_ancillary order by l.order_id, l.total_minor desc
    ), pairs as (
      select m1.product_id as f, m2.product_id as s, extract(epoch from (s2.placed_at - s1.placed_at)) / 86400 as days
      from sales s1 join sales s2 on s2.customer_id = s1.customer_id and s2.rn = 2
      join mains m1 on m1.order_id = s1.id join mains m2 on m2.order_id = s2.id
      where s1.rn = 1
    )
    select p.f, pf.title as f_title, p.s, ps.title as s_title, count(*)::int as n, percentile_cont(0.5) within group (order by p.days) as med
    from pairs p join products pf on pf.id = p.f join products ps on ps.id = p.s
    group by 1, 2, 3, 4 order by n desc limit ${limit}`);
  return rows.rows.map((r) => ({ first: { id: r.f, title: r.f_title }, second: { id: r.s, title: r.s_title }, customers: Number(r.n), medianDays: r.med === null ? null : Math.round(Number(r.med)) }));
}


