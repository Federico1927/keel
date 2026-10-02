import { sql } from "@hullwise/db";
import { SALE_STATUSES } from "@hullwise/core";
import type { ServiceContext } from "../context";

const SALE = SALE_STATUSES as readonly string[];

export interface SegmentInsights {
  members: number;
  /** Members with at least one sale order. */
  buyers: number;
  /** Average total spent per member (members without orders count as zero), and per order. */
  avgSpentMinor: number | null;
  aovMinor: number | null;
  avgOrders: number | null;
  topProducts: { productId: string; title: string; customers: number; units: number; revenueMinor: number }[];
  /** Categories are product types. */
  topCategories: { category: string; customers: number; units: number; revenueMinor: number }[];
  /** Option values of the bought variants (any option name the catalog uses). */
  topOptionValues: { option: string; value: string; customers: number; units: number }[];
  /** Sale orders of members by sales channel. */
  channels: { channel: string; orders: number; revenueMinor: number }[];
  /** Members reachable with marketing consent, by contact channel. */
  reachable: { email: number; phone: number };
}

/**
 * What a segment's members buy (core CRM, no add-on): top products, categories and option values,
 * average spend, sales-channel mix and reachability. Sale scope as in the P/L; both groups count.
 */
export async function segmentInsights(ctx: ServiceContext, segmentId: string, limit = 8): Promise<SegmentInsights> {
  const t = ctx.tenantId;
  const members = sql`select customer_id from segment_memberships where tenant_id = ${t} and segment_id = ${segmentId}`;
  const lines = sql`from orders o join order_lines l on l.order_id = o.id left join products p on p.id = l.product_id where o.tenant_id = ${t} and o.status in ${SALE} and o.customer_id in (${members})`;
  const [head] = (await ctx.tx.execute<{ members: number; buyers: number; revenue: number; orders: number; email: number; phone: number }>(sql`
    with m as (${members}),
    s as (select o.customer_id, count(*)::int as orders, sum(o.total_minor)::bigint as revenue from orders o where o.tenant_id = ${t} and o.status in ${SALE} and o.customer_id in (select customer_id from m) group by 1)
    select (select count(*) from m)::int as members, (select count(*) from s)::int as buyers, coalesce((select sum(revenue) from s), 0)::float8 as revenue, coalesce((select sum(orders) from s), 0)::int as orders,
      (select count(*) from customers c where c.id in (select customer_id from m) and c.accepts_marketing and c.email is not null)::int as email,
      (select count(*) from customers c where c.id in (select customer_id from m) and c.accepts_marketing and c.phone_e164 is not null)::int as phone`)).rows;
  const products = await ctx.tx.execute<{ product_id: string; title: string; customers: number; units: number; revenue: number }>(sql`
    select l.product_id, coalesce(max(p.title), max(l.title)) as title, count(distinct o.customer_id)::int as customers, sum(l.quantity)::int as units, sum(l.total_minor)::float8 as revenue
    ${lines} and l.product_id is not null and not l.is_ancillary
    group by l.product_id order by units desc, revenue desc limit ${limit}`);
  const categories = await ctx.tx.execute<{ category: string; customers: number; units: number; revenue: number }>(sql`
    select p.product_type as category, count(distinct o.customer_id)::int as customers, sum(l.quantity)::int as units, sum(l.total_minor)::float8 as revenue
    from orders o join order_lines l on l.order_id = o.id join products p on p.id = l.product_id
    where o.tenant_id = ${t} and o.status in ${SALE} and o.customer_id in (${members}) and p.product_type is not null
    group by 1 order by units desc limit ${limit}`);
  const options = await ctx.tx.execute<{ option: string; value: string; customers: number; units: number }>(sql`
    select e.key as option, e.value as value, count(distinct o.customer_id)::int as customers, sum(l.quantity)::int as units
    from orders o join order_lines l on l.order_id = o.id join product_variants pv on pv.id = l.variant_id
    cross join lateral jsonb_each_text(case when jsonb_typeof(pv.option_values) = 'object' then pv.option_values else '{}'::jsonb end) e
    where o.tenant_id = ${t} and o.status in ${SALE} and o.customer_id in (${members})
    group by 1, 2 order by units desc, 1, 2 limit ${limit * 2}`);
  const channels = await ctx.tx.execute<{ channel: string; orders: number; revenue: number }>(sql`
    select o.source_channel as channel, count(*)::int as orders, sum(o.total_minor)::float8 as revenue
    from orders o where o.tenant_id = ${t} and o.status in ${SALE} and o.customer_id in (${members})
    group by 1 order by orders desc`);
  const n = head?.members ?? 0;
  const orders = head?.orders ?? 0;
  const revenue = Number(head?.revenue ?? 0);
  return {
    members: n,
    buyers: head?.buyers ?? 0,
    avgSpentMinor: n ? Math.round(revenue / n) : null,
    aovMinor: orders ? Math.round(revenue / orders) : null,
    avgOrders: n ? orders / n : null,
    topProducts: products.rows.map((r) => ({ productId: r.product_id, title: r.title, customers: r.customers, units: r.units, revenueMinor: Math.round(Number(r.revenue)) })),
    topCategories: categories.rows.map((r) => ({ category: r.category, customers: r.customers, units: r.units, revenueMinor: Math.round(Number(r.revenue)) })),
    topOptionValues: options.rows.map((r) => ({ option: r.option, value: r.value, customers: r.customers, units: r.units })),
    channels: channels.rows.map((r) => ({ channel: r.channel, orders: r.orders, revenueMinor: Math.round(Number(r.revenue)) })),
    reachable: { email: head?.email ?? 0, phone: head?.phone ?? 0 },
  };
}
