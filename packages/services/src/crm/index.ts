import { and, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { SALE_STATUSES, assignHoldout, isGroup, rfmTier, segmentFieldCatalog, validateSegmentRules, type CustomerProfile, type RfmTier, type SegmentGroup, type SegmentLeaf } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { customerPrediction, type CustomerPredictionView } from "./predictions";

const SALE = SALE_STATUSES as readonly string[];
const RETURNED = ["returned", "returned_partial", "refunded"];

/**
 * Customer profile: one row per customer with everything the segment fields read, computed
 * from Hullwise's canonical orders (sale scope = same rule as the P/L) and the customer row.
 * Returned as a CTE body so list, preview, evaluation and RFM all share one definition.
 */
function profileCte(ctx: ServiceContext, now: Date, onlyCustomers?: string[]): SQL {
  const t = ctx.tenantId;
  // restricting every branch (not just the outer select) keeps incremental evaluation cheap
  const only = (col: SQL) => (onlyCustomers ? sql` and ${col} = any(${sql.param(onlyCustomers)}::uuid[])` : sql``);
  return sql`
    select c.id as customer_id, c.first_name, c.last_name, c.email, c.phone_e164 as phone, c.country, c.city, c.accepts_marketing, c.tags, c.platform_created_at,
      coalesce(a.orders_count, 0)::int as orders_count,
      coalesce(a.cancelled_count, 0)::int as cancelled_count,
      coalesce(a.returns_count, 0)::int as returns_count,
      coalesce(a.total_spent, 0)::int as total_spent,
      case when coalesce(a.orders_count, 0) > 0 then round(a.total_spent::numeric / a.orders_count)::int else null end as aov,
      a.last_order_at, a.first_order_at,
      case when a.last_order_at is null then null else floor(extract(epoch from (${now}::timestamptz - a.last_order_at)) / 86400)::int end as days_since_last_order,
      case when a.first_order_at is null then null else floor(extract(epoch from (${now}::timestamptz - a.first_order_at)) / 86400)::int end as days_since_first_order,
      coalesce(a.payment_methods, '{}'::text[]) as payment_methods,
      coalesce(pr.product_ids, '{}'::uuid[]) as product_ids,
      coalesce(pr.product_types, '{}'::text[]) as product_types,
      (abs(hashtext(c.id::text)) % 100)::int as random_pct,
      cp.churn_risk,
      (cp.p_alive * 100)::float8 as p_alive_pct,
      cp.predicted_value_365_minor as predicted_value,
      case when cp.next_order_at is null then null else floor(extract(epoch from (cp.next_order_at - ${now}::timestamptz)) / 86400)::int end as days_to_next_order
    from customers c
    left join customer_predictions cp on cp.customer_id = c.id and cp.tenant_id = ${t}
    left join (
      select o.customer_id,
        count(*) filter (where o.status in ${SALE}) as orders_count,
        count(*) filter (where o.status = 'cancelled') as cancelled_count,
        count(*) filter (where o.status in ${RETURNED}) as returns_count,
        coalesce(sum(o.total_minor) filter (where o.status in ${SALE}), 0) as total_spent,
        max(o.placed_at) filter (where o.status in ${SALE}) as last_order_at,
        min(o.placed_at) filter (where o.status in ${SALE}) as first_order_at,
        array_agg(distinct o.payment_method) filter (where o.status in ${SALE}) as payment_methods
      from orders o where o.tenant_id = ${t} and o.customer_id is not null and o.replaced_by_order_id is null${only(sql`o.customer_id`)} group by o.customer_id
    ) a on a.customer_id = c.id
    left join (
      select o.customer_id,
        array_agg(distinct l.product_id) filter (where l.product_id is not null) as product_ids,
        array_agg(distinct p.product_type) filter (where p.product_type is not null) as product_types
      from orders o join order_lines l on l.order_id = o.id left join products p on p.id = l.product_id
      where o.tenant_id = ${t} and o.customer_id is not null and o.status in ${SALE}${only(sql`o.customer_id`)} group by o.customer_id
    ) pr on pr.customer_id = c.id
    where c.tenant_id = ${t}${only(sql`c.id`)}`;
}

const RFM_RECENCY_SQL = sql`case when p.days_since_last_order is null then null when p.days_since_last_order <= 90 then 'r0_90' when p.days_since_last_order <= 180 then 'r91_180' when p.days_since_last_order <= 365 then 'r181_365' when p.days_since_last_order <= 730 then 'r366_730' else 'r730_plus' end`;
const RFM_FREQUENCY_SQL = sql`case when p.orders_count < 1 then null when p.orders_count = 1 then 'f1' when p.orders_count = 2 then 'f2' when p.orders_count <= 4 then 'f3_4' else 'f5_plus' end`;
const RFM_TIER_SQL = sql`case
  when p.orders_count < 1 or p.days_since_last_order is null then null
  when p.days_since_last_order > 730 then 'lost'
  when p.days_since_last_order > 365 then 'dormant'
  when p.orders_count >= 5 and p.days_since_last_order <= 180 then 'champions'
  when p.orders_count >= 5 then 'loyal'
  when p.orders_count >= 3 and p.days_since_last_order <= 180 then 'loyal'
  when p.orders_count >= 2 and p.days_since_last_order > 180 then 'at_risk'
  when p.orders_count >= 2 then 'promising'
  when p.days_since_last_order <= 90 then 'new'
  else 'one_time' end`;

/** Whitelisted SQL expression per field over the profile alias `p`; values never reach SQL except as parameters. */
const FIELD_SQL: Record<string, SQL> = {
  orders_count: sql`p.orders_count`,
  cancelled_count: sql`p.cancelled_count`,
  returns_count: sql`p.returns_count`,
  total_spent: sql`p.total_spent`,
  aov: sql`p.aov`,
  days_since_last_order: sql`p.days_since_last_order`,
  days_since_first_order: sql`p.days_since_first_order`,
  accepts_marketing: sql`p.accepts_marketing`,
  country: sql`p.country`,
  tags: sql`p.tags`,
  payment_methods: sql`p.payment_methods`,
  bought_product: sql`p.product_ids`,
  bought_product_type: sql`p.product_types`,
  rfm_recency: RFM_RECENCY_SQL,
  rfm_frequency: RFM_FREQUENCY_SQL,
  rfm_tier: RFM_TIER_SQL,
  churn_risk: sql`p.churn_risk`,
  p_alive: sql`p.p_alive_pct`,
  predicted_value: sql`p.predicted_value`,
  days_to_next_order: sql`p.days_to_next_order`,
  random_pct: sql`p.random_pct`,
};

export class SegmentRuleError extends Error {
  constructor(public readonly errors: { path: string; code: string }[]) {
    super("invalid_segment_rules");
  }
}

/** Compiles validated rules to a WHERE fragment; throws on anything the validator rejects. */
export function compileSegmentRules(input: unknown): SQL {
  const { rules, errors } = validateSegmentRules(input);
  if (!rules) throw new SegmentRuleError(errors);
  return compileGroup(rules);
}

function compileGroup(g: SegmentGroup): SQL {
  if (g.conditions.length === 0) return sql`true`;
  const parts = g.conditions.map((c) => (isGroup(c) ? sql`(${compileGroup(c)})` : sql`(${compileLeaf(c)})`));
  return sql.join(parts, g.match === "all" ? sql` and ` : sql` or `);
}

/** Arrays must travel as one driver parameter (pg serialises them); the template would otherwise expand them to a tuple. */
function textArray(v: unknown): SQL {
  return sql`${sql.param(v as string[])}::text[]`;
}
function uuidArray(v: unknown): SQL {
  return sql`${sql.param(v as string[])}::uuid[]`;
}

function compileLeaf(leaf: SegmentLeaf): SQL {
  const def = segmentFieldCatalog()[leaf.field];
  const expr = FIELD_SQL[leaf.field];
  if (!def || !expr) throw new SegmentRuleError([{ path: leaf.field, code: "unknown_field" }]);
  const v = leaf.value;
  switch (leaf.op) {
    case "is_null": return sql`${expr} is null`;
    case "not_null": return sql`${expr} is not null`;
    case "gte": return sql`${expr} >= ${v as number}`;
    case "lte": return sql`${expr} <= ${v as number}`;
    case "gt": return sql`${expr} > ${v as number}`;
    case "lt": return sql`${expr} < ${v as number}`;
    case "between": return sql`${expr} between ${(v as number[])[0]} and ${(v as number[])[1]}`;
    case "eq": return def.type === "boolean" ? sql`coalesce(${expr}, false) = ${v as boolean}` : sql`${expr} = ${v as number}`;
    case "in": return sql`${expr} = any(${textArray(v)})`;
    case "not_in": return sql`(${expr} is null or not (${expr} = any(${textArray(v)})))`;
    case "any": return def.type === "uuid_array" ? sql`coalesce(${expr} && ${uuidArray(v)}, false)` : sql`coalesce(${expr} && ${textArray(v)}, false)`;
    case "none": return def.type === "uuid_array" ? sql`not coalesce(${expr} && ${uuidArray(v)}, false)` : sql`not coalesce(${expr} && ${textArray(v)}, false)`;
    case "all": return def.type === "uuid_array" ? sql`coalesce(${expr} @> ${uuidArray(v)}, false)` : sql`coalesce(${expr} @> ${textArray(v)}, false)`;
  }
}

type ProfileRow = {
  customer_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  accepts_marketing: boolean;
  tags: string[];
  platform_created_at: Date | string | null;
  orders_count: number;
  cancelled_count: number;
  returns_count: number;
  total_spent: number;
  aov: number | null;
  last_order_at: Date | string | null;
  first_order_at: Date | string | null;
  days_since_last_order: number | null;
  days_since_first_order: number | null;
  payment_methods: string[];
  product_ids: string[];
  product_types: string[];
  random_pct: number;
  churn_risk: string | null;
  p_alive_pct: number | null;
  predicted_value: number | null;
  days_to_next_order: number | null;
};

export interface CustomerRow extends CustomerProfile {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  lastOrderAt: Date | null;
  firstOrderAt: Date | null;
  platformCreatedAt: Date | null;
  tier: RfmTier | null;
}

/** Raw rows from `execute` carry timestamps as strings (drizzle's pg type parsers); normalise to Date. */
function toDate(v: Date | string | null): Date | null {
  return v === null || v === undefined ? null : v instanceof Date ? v : new Date(v);
}

function toRow(r: ProfileRow): CustomerRow {
  return {
    customerId: r.customer_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, city: r.city, country: r.country,
    ordersCount: r.orders_count, cancelledCount: r.cancelled_count, returnsCount: r.returns_count, totalSpentMinor: r.total_spent, aovMinor: r.aov,
    daysSinceLastOrder: r.days_since_last_order, daysSinceFirstOrder: r.days_since_first_order, lastOrderAt: toDate(r.last_order_at), firstOrderAt: toDate(r.first_order_at),
    platformCreatedAt: toDate(r.platform_created_at), acceptsMarketing: r.accepts_marketing, tags: r.tags ?? [], paymentMethods: r.payment_methods ?? [],
    productIds: r.product_ids ?? [], productTypes: r.product_types ?? [], randomPct: r.random_pct, tier: rfmTier(r.orders_count, r.days_since_last_order),
    churnRisk: r.churn_risk, pAlivePct: r.p_alive_pct === null ? null : Number(r.p_alive_pct), predictedValueMinor: r.predicted_value, daysToNextOrder: r.days_to_next_order,
  };
}

export interface CustomerFilters {
  q?: string;
  country?: string;
  acceptsMarketing?: boolean;
  tier?: string;
  minOrders?: number;
  segmentId?: string;
  churnRisk?: string;
  sort?: "last_order" | "total_spent" | "orders" | "name" | "predicted_value";
  page?: number;
  pageSize?: number;
}

/** Server-side customer list over the profile CTE. */
export async function listCustomers(ctx: ServiceContext, f: CustomerFilters = {}): Promise<{ rows: CustomerRow[]; total: number; page: number; pageSize: number; countries: string[] }> {
  const now = ctx.now ?? new Date();
  const page = Math.max(1, f.page ?? 1);
  // pages ask for 50; the CSV export reads in larger chunks
  const pageSize = Math.min(5000, Math.max(1, f.pageSize ?? 50));
  const conds: SQL[] = [sql`true`];
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    conds.push(sql`(lower(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) like ${like} or lower(coalesce(p.email,'')) like ${like} or coalesce(p.phone,'') like ${"%" + f.q.replace(/\s+/g, "") + "%"})`);
  }
  if (f.country) conds.push(sql`p.country = ${f.country}`);
  if (f.acceptsMarketing !== undefined) conds.push(sql`p.accepts_marketing = ${f.acceptsMarketing}`);
  if (f.tier) conds.push(sql`${RFM_TIER_SQL} = ${f.tier}`);
  if (f.minOrders) conds.push(sql`p.orders_count >= ${f.minOrders}`);
  if (f.churnRisk) conds.push(sql`p.churn_risk = ${f.churnRisk}`);
  if (f.segmentId) conds.push(sql`exists (select 1 from segment_memberships m where m.segment_id = ${f.segmentId} and m.customer_id = p.customer_id)`);
  const where = sql.join(conds, sql` and `);
  const order = f.sort === "total_spent" ? sql`p.total_spent desc` : f.sort === "orders" ? sql`p.orders_count desc, p.total_spent desc` : f.sort === "name" ? sql`p.last_name nulls last, p.first_name` : f.sort === "predicted_value" ? sql`p.predicted_value desc nulls last` : sql`p.last_order_at desc nulls last`;
  const rows = await ctx.tx.execute<ProfileRow>(sql`with p as materialized (${profileCte(ctx, now)}) select p.* from p where ${where} order by ${order}, p.customer_id limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const count = await ctx.tx.execute<{ n: number }>(sql`with p as materialized (${profileCte(ctx, now)}) select count(*)::int as n from p where ${where}`);
  const countries = await ctx.tx.execute<{ country: string }>(sql`select distinct country from customers where tenant_id = ${ctx.tenantId} and country is not null order by 1`);
  return { rows: rows.rows.map(toRow), total: count.rows[0]?.n ?? 0, page, pageSize, countries: countries.rows.map((r) => r.country) };
}

/** All profiles (or a subset) as the pure core type; used for RFM and for parity tests. */
export async function customerProfiles(ctx: ServiceContext, customerIds?: string[]): Promise<CustomerRow[]> {
  const now = ctx.now ?? new Date();
  const filter = customerIds ? sql`where p.customer_id = any(${sql.param(customerIds)}::uuid[])` : sql``;
  const rows = await ctx.tx.execute<ProfileRow>(sql`with p as materialized (${profileCte(ctx, now)}) select p.* from p ${filter}`);
  return rows.rows.map(toRow);
}

export interface SegmentPreview {
  count: number;
  contactable: number;
  sample: { customerId: string; name: string; email: string | null; ordersCount: number; totalSpentMinor: number; lastOrderAt: Date | null }[];
}

/** Count + stable sample for the builder; the sample order is a hash so it does not jump between edits. */
export async function previewSegment(ctx: ServiceContext, rules: unknown, sampleSize = 20): Promise<SegmentPreview> {
  const now = ctx.now ?? new Date();
  const where = compileSegmentRules(rules);
  const agg = await ctx.tx.execute<{ n: number; c: number }>(sql`with p as materialized (${profileCte(ctx, now)}) select count(*)::int as n, count(*) filter (where p.accepts_marketing)::int as c from p where ${where}`);
  const sample = await ctx.tx.execute<ProfileRow>(sql`with p as materialized (${profileCte(ctx, now)}) select p.* from p where ${where} order by hashtext(p.customer_id::text) limit ${sampleSize}`);
  return {
    count: agg.rows[0]?.n ?? 0,
    contactable: agg.rows[0]?.c ?? 0,
    sample: sample.rows.map((r) => ({ customerId: r.customer_id, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.customer_id.slice(0, 8), email: r.email, ordersCount: r.orders_count, totalSpentMinor: r.total_spent, lastOrderAt: toDate(r.last_order_at) })),
  };
}

export interface SegmentInput {
  name: string;
  description?: string | null;
  rules: unknown;
  holdoutPercentage: number;
  liveUpdates?: boolean;
}

export async function saveSegment(ctx: ServiceContext, input: SegmentInput, segmentId?: string): Promise<string> {
  const { rules, errors } = validateSegmentRules(input.rules);
  if (!rules) throw new SegmentRuleError(errors);
  const holdout = Math.min(50, Math.max(0, Math.round(input.holdoutPercentage)));
  if (segmentId) {
    await ctx.tx.update(schema.segments).set({ name: input.name, description: input.description ?? null, rules, holdoutPercentage: holdout, ...(input.liveUpdates === undefined ? {} : { liveUpdates: input.liveUpdates }), updatedAt: new Date() }).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, segmentId)));
    return segmentId;
  }
  const [row] = await ctx.tx.insert(schema.segments).values({ tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, rules, holdoutPercentage: holdout, liveUpdates: input.liveUpdates ?? false, createdBy: ctx.actor.userId }).returning({ id: schema.segments.id });
  return row!.id;
}

export async function deleteSegment(ctx: ServiceContext, segmentId: string): Promise<void> {
  await ctx.tx.delete(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, segmentId)));
}

/**
 * Materialises memberships: inserts new matches with a stable treated/holdout group,
 * removes customers that no longer match, never moves an existing member between groups.
 */
export async function evaluateSegment(ctx: ServiceContext, segmentId: string): Promise<{ count: number; holdout: number }> {
  const now = ctx.now ?? new Date();
  const [segment] = await ctx.tx.select().from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, segmentId))).limit(1);
  if (!segment) throw new Error("segment_not_found");
  const where = compileSegmentRules(segment.rules);
  const matches = await ctx.tx.execute<{ customer_id: string }>(sql`with p as materialized (${profileCte(ctx, now)}) select p.customer_id from p where ${where}`);
  const ids = matches.rows.map((r) => r.customer_id);
  const idSet = new Set(ids);
  const existing = await ctx.tx.select({ customerId: schema.segmentMemberships.customerId, groupName: schema.segmentMemberships.groupName }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, segmentId));
  const existingSet = new Set(existing.map((e) => e.customerId));
  const stale = existing.filter((e) => !idSet.has(e.customerId)).map((e) => e.customerId);
  if (stale.length) await ctx.tx.delete(schema.segmentMemberships).where(and(eq(schema.segmentMemberships.segmentId, segmentId), inArray(schema.segmentMemberships.customerId, stale)));
  const fresh = ids.filter((id) => !existingSet.has(id));
  for (let i = 0; i < fresh.length; i += 1000) {
    const chunk = fresh.slice(i, i + 1000).map((customerId) => ({ tenantId: ctx.tenantId, segmentId, customerId, groupName: assignHoldout(segmentId, customerId, segment.holdoutPercentage, segment.holdoutSalt), evaluatedAt: now }));
    if (chunk.length) await ctx.tx.insert(schema.segmentMemberships).values(chunk).onConflictDoNothing();
  }
  const [agg] = await ctx.tx.select({ n: sql<number>`count(*)::int`, h: sql<number>`count(*) filter (where ${schema.segmentMemberships.groupName} = 'holdout')::int` }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, segmentId));
  await ctx.tx.update(schema.segments).set({ lastCount: agg?.n ?? 0, lastEvaluatedAt: now }).where(eq(schema.segments.id, segmentId));
  return { count: agg?.n ?? 0, holdout: agg?.h ?? 0 };
}

export interface SegmentMemberRow extends CustomerRow {
  groupName: string;
}

/** Members with profile columns, for the export and the detail table. */
export async function segmentMembers(ctx: ServiceContext, segmentId: string, opts: { group?: "treated" | "holdout"; limit?: number; offset?: number } = {}): Promise<SegmentMemberRow[]> {
  const now = ctx.now ?? new Date();
  const groupFilter = opts.group ? sql`and m.group_name = ${opts.group}` : sql``;
  const limit = opts.limit ? sql`limit ${opts.limit}` : sql``;
  const offset = opts.offset ? sql`offset ${opts.offset}` : sql``;
  const rows = await ctx.tx.execute<ProfileRow & { group_name: string }>(sql`with p as materialized (${profileCte(ctx, now)}) select p.*, m.group_name from segment_memberships m join p on p.customer_id = m.customer_id where m.segment_id = ${segmentId} ${groupFilter} order by p.total_spent desc, p.customer_id ${limit} ${offset}`);
  return rows.rows.map((r) => ({ ...toRow(r), groupName: r.group_name }));
}

export async function listSegments(ctx: ServiceContext) {
  return ctx.tx.select().from(schema.segments).where(eq(schema.segments.tenantId, ctx.tenantId)).orderBy(schema.segments.name);
}

export interface CustomerDetail {
  customer: CustomerRow;
  orders: { id: string; name: string; placedAt: Date; status: string; paymentMethod: string; totalMinor: number; currency: string }[];
  segments: { id: string; name: string; groupName: string }[];
  returns: number;
  prediction: CustomerPredictionView | null;
}

export async function customerDetail(ctx: ServiceContext, customerId: string): Promise<CustomerDetail | null> {
  const [customer] = await customerProfiles(ctx, [customerId]);
  if (!customer) return null;
  const orders = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, status: schema.orders.status, paymentMethod: schema.orders.paymentMethod, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.customerId, customerId))).orderBy(desc(schema.orders.placedAt)).limit(100);
  const memberships = await ctx.tx.select({ id: schema.segments.id, name: schema.segments.name, groupName: schema.segmentMemberships.groupName }).from(schema.segmentMemberships).innerJoin(schema.segments, eq(schema.segments.id, schema.segmentMemberships.segmentId)).where(eq(schema.segmentMemberships.customerId, customerId));
  return { customer, orders, segments: memberships, returns: customer.returnsCount, prediction: await customerPrediction(ctx, customerId) };
}

export interface MembershipDelta {
  segmentId: string;
  checked: number;
  added: number;
  removed: number;
  count: number;
}

/**
 * Incremental evaluation: re-checks only the given customers against the rules, adds the new
 * matches with their stable group and removes those who stopped matching. Same result as a full
 * evaluation for these customers; everyone else is untouched.
 */
export async function evaluateSegmentForCustomers(ctx: ServiceContext, segmentId: string, customerIds: string[]): Promise<MembershipDelta> {
  const now = ctx.now ?? new Date();
  const [segment] = await ctx.tx.select().from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, segmentId))).limit(1);
  if (!segment) throw new Error("segment_not_found");
  let added = 0;
  let removed = 0;
  if (customerIds.length) {
    const where = compileSegmentRules(segment.rules);
    const matches = await ctx.tx.execute<{ customer_id: string }>(sql`with p as materialized (${profileCte(ctx, now, customerIds)}) select p.customer_id from p where ${where}`);
    const matching = new Set(matches.rows.map((r) => r.customer_id));
    const existing = await ctx.tx.select({ customerId: schema.segmentMemberships.customerId }).from(schema.segmentMemberships).where(and(eq(schema.segmentMemberships.segmentId, segmentId), inArray(schema.segmentMemberships.customerId, customerIds)));
    const present = new Set(existing.map((e) => e.customerId));
    const stale = [...present].filter((id) => !matching.has(id));
    const fresh = [...matching].filter((id) => !present.has(id));
    if (stale.length) await ctx.tx.delete(schema.segmentMemberships).where(and(eq(schema.segmentMemberships.segmentId, segmentId), inArray(schema.segmentMemberships.customerId, stale)));
    if (fresh.length) await ctx.tx.insert(schema.segmentMemberships).values(fresh.map((customerId) => ({ tenantId: ctx.tenantId, segmentId, customerId, groupName: assignHoldout(segmentId, customerId, segment.holdoutPercentage, segment.holdoutSalt), evaluatedAt: now }))).onConflictDoNothing();
    added = fresh.length;
    removed = stale.length;
  }
  const [agg] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, segmentId));
  await ctx.tx.update(schema.segments).set({ lastCount: agg?.n ?? 0, lastEvaluatedAt: now }).where(eq(schema.segments.id, segmentId));
  return { segmentId, checked: customerIds.length, added, removed, count: agg?.n ?? 0 };
}

/** Customers whose orders or profile changed after `since`: the only ones whose membership can have changed by an event. */
export async function customersChangedSince(ctx: ServiceContext, since: Date): Promise<string[]> {
  const rows = await ctx.tx.execute<{ id: string }>(sql`
    select customer_id as id from orders where tenant_id = ${ctx.tenantId} and customer_id is not null and updated_at > ${since}
    union
    select id from customers where tenant_id = ${ctx.tenantId} and updated_at > ${since}`);
  return rows.rows.map((r) => r.id);
}

/**
 * Keeps live segments current. Incremental (every few minutes): only customers changed since
 * each segment's last evaluation. Full (nightly): everyone, because time-based conditions such
 * as "days since last order" or the nightly predictions change without any event.
 */
export async function refreshLiveSegments(ctx: ServiceContext, opts: { full?: boolean } = {}): Promise<MembershipDelta[]> {
  const live = await ctx.tx.select({ id: schema.segments.id, lastEvaluatedAt: schema.segments.lastEvaluatedAt }).from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.liveUpdates, true)));
  const out: MembershipDelta[] = [];
  for (const s of live) {
    if (opts.full || !s.lastEvaluatedAt) {
      const before = await ctx.tx.select({ customerId: schema.segmentMemberships.customerId }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, s.id));
      const r = await evaluateSegment(ctx, s.id);
      const after = new Set((await ctx.tx.select({ customerId: schema.segmentMemberships.customerId }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, s.id))).map((m) => m.customerId));
      const had = new Set(before.map((b) => b.customerId));
      out.push({ segmentId: s.id, checked: -1, added: [...after].filter((x) => !had.has(x)).length, removed: [...had].filter((x) => !after.has(x)).length, count: r.count });
      continue;
    }
    out.push(await evaluateSegmentForCustomers(ctx, s.id, await customersChangedSince(ctx, s.lastEvaluatedAt)));
  }
  return out;
}
