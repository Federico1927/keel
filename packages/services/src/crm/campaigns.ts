import { and, desc, eq, schema, sql } from "@keel/db";
import { RETENTION_CHANNELS, campaignUplift, minimumDetectableUplift, renderMessage, type CustomerOutcome, type RetentionChannel, type UpliftReport } from "@keel/core";
import type { MessagingChannel } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";
import { evaluateSegment } from "./index";

const DAY = 864e5;

export class RetentionCampaignError extends Error {
  constructor(public readonly code: "not_found" | "already_sent" | "no_segment" | "empty_segment" | "invalid_input") {
    super(code);
  }
}

export interface RetentionCampaignInput {
  name: string;
  segmentId: string;
  channel: RetentionChannel;
  message: string;
  discountCode?: string | null;
  costPerMessageMinor: number;
  attributionDays: number;
}

export async function saveRetentionCampaign(ctx: ServiceContext, input: RetentionCampaignInput, campaignId?: string): Promise<string> {
  if (!RETENTION_CHANNELS.includes(input.channel) || input.attributionDays < 1 || input.attributionDays > 90 || input.costPerMessageMinor < 0) throw new RetentionCampaignError("invalid_input");
  const [segment] = await ctx.tx.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, input.segmentId))).limit(1);
  if (!segment) throw new RetentionCampaignError("no_segment");
  const values = { name: input.name, segmentId: input.segmentId, channel: input.channel, message: input.message, discountCode: input.discountCode || null, costPerMessageMinor: Math.round(input.costPerMessageMinor), attributionDays: Math.round(input.attributionDays) };
  if (campaignId) {
    const [current] = await ctx.tx.select({ status: schema.retentionCampaigns.status }).from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
    if (!current) throw new RetentionCampaignError("not_found");
    if (current.status !== "draft") throw new RetentionCampaignError("already_sent");
    await ctx.tx.update(schema.retentionCampaigns).set({ ...values, updatedAt: new Date() }).where(eq(schema.retentionCampaigns.id, campaignId));
    return campaignId;
  }
  const [row] = await ctx.tx.insert(schema.retentionCampaigns).values({ tenantId: ctx.tenantId, ...values, createdBy: ctx.actor.userId }).returning({ id: schema.retentionCampaigns.id });
  return row!.id;
}

export async function deleteRetentionCampaign(ctx: ServiceContext, campaignId: string): Promise<void> {
  const [current] = await ctx.tx.select({ status: schema.retentionCampaigns.status }).from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
  if (!current) throw new RetentionCampaignError("not_found");
  if (current.status !== "draft") throw new RetentionCampaignError("already_sent");
  await ctx.tx.delete(schema.retentionCampaigns).where(eq(schema.retentionCampaigns.id, campaignId));
}

type Audience = { customer_id: string; group_name: string; first_name: string | null; email: string | null; phone_e164: string | null }[];

/** Segment members who accept marketing, with their stable group. Consent is applied before the split is read, so both groups are comparable. */
async function audience(ctx: ServiceContext, segmentId: string): Promise<Audience> {
  const rows = await ctx.tx.execute<Audience[number]>(sql`
    select m.customer_id, m.group_name, c.first_name, c.email, c.phone_e164
    from segment_memberships m join customers c on c.id = m.customer_id
    where m.tenant_id = ${ctx.tenantId} and m.segment_id = ${segmentId} and c.accepts_marketing
    order by m.customer_id`);
  return rows.rows;
}

export interface SendPreview {
  treated: number;
  holdout: number;
  holdoutPercentage: number;
  /** Repeat-purchase rate of the segment over a past window of the same length, as the expected baseline. */
  baselineRate: number | null;
  minimumDetectableUplift: number | null;
}

/**
 * What sending would do now: group sizes and the smallest uplift the control group can detect.
 * Re-evaluates the segment first, as sending does (groups of existing members never move).
 */
export async function previewRetentionSend(ctx: ServiceContext, campaignId: string): Promise<SendPreview> {
  const c = await loadCampaign(ctx, campaignId);
  if (!c.segmentId) throw new RetentionCampaignError("no_segment");
  await evaluateSegment(ctx, c.segmentId);
  const [segment] = await ctx.tx.select({ holdout: schema.segments.holdoutPercentage }).from(schema.segments).where(eq(schema.segments.id, c.segmentId)).limit(1);
  const people = await audience(ctx, c.segmentId);
  const treated = people.filter((p) => p.group_name === "treated").length;
  const holdout = people.length - treated;
  const now = ctx.now ?? new Date();
  const since = new Date(now.getTime() - c.attributionDays * DAY);
  const ids = people.map((p) => p.customer_id);
  let baselineRate: number | null = null;
  if (ids.length) {
    const r = await ctx.tx.execute<{ n: number }>(sql`select count(distinct customer_id)::int as n from orders where tenant_id = ${ctx.tenantId} and customer_id = any(${sql.param(ids)}::uuid[]) and placed_at > ${since} and status in ('confirmed', 'fulfilling', 'shipped', 'delivered', 'returned_partial')`);
    baselineRate = (r.rows[0]?.n ?? 0) / ids.length;
  }
  return { treated, holdout, holdoutPercentage: segment?.holdout ?? 0, baselineRate, minimumDetectableUplift: baselineRate === null ? null : minimumDetectableUplift(Math.max(baselineRate, 0.005), treated, holdout) };
}

export interface SendResult {
  treated: number;
  holdout: number;
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Sends a draft: re-evaluates the segment, snapshots the audience into exposures, messages the
 * treated group through the channel and records the control group without contacting it.
 * The "manual" channel records exposures only, for campaigns sent from another tool.
 */
export async function sendRetentionCampaign(ctx: ServiceContext, campaignId: string, channel: MessagingChannel): Promise<SendResult> {
  const c = await loadCampaign(ctx, campaignId);
  if (c.status !== "draft") throw new RetentionCampaignError("already_sent");
  if (!c.segmentId) throw new RetentionCampaignError("no_segment");
  await evaluateSegment(ctx, c.segmentId);
  const people = await audience(ctx, c.segmentId);
  if (!people.length) throw new RetentionCampaignError("empty_segment");
  const now = ctx.now ?? new Date();
  const result: SendResult = { treated: 0, holdout: 0, delivered: 0, failed: 0, skipped: 0 };
  const rows: (typeof schema.retentionExposures.$inferInsert)[] = [];
  for (const p of people) {
    const base = { tenantId: ctx.tenantId, campaignId, customerId: p.customer_id, groupName: p.group_name, exposedAt: now };
    if (p.group_name === "holdout") {
      result.holdout++;
      rows.push({ ...base, status: "held_out" });
      continue;
    }
    result.treated++;
    if (c.channel === "manual") {
      result.delivered++;
      rows.push({ ...base, status: "sent" });
      continue;
    }
    const to = c.channel === "email" ? p.email : p.phone_e164;
    if (!to) {
      result.skipped++;
      rows.push({ ...base, status: "skipped" });
      continue;
    }
    try {
      const vars = { first_name: p.first_name ?? "", code: c.discountCode ?? "" };
      const { messageId } = await channel.sendMessage({ to, template: renderMessage(c.message, vars), variables: vars });
      result.delivered++;
      rows.push({ ...base, status: "sent", messageId });
    } catch (e) {
      result.failed++;
      rows.push({ ...base, status: "failed", error: e instanceof Error ? e.message.slice(0, 300) : "error" });
    }
  }
  for (let i = 0; i < rows.length; i += 1000) await ctx.tx.insert(schema.retentionExposures).values(rows.slice(i, i + 1000));
  await ctx.tx.update(schema.retentionCampaigns).set({ status: "sent", sentAt: now, sentBy: ctx.actor.userId, treatedCount: result.treated, holdoutCount: result.holdout, deliveredCount: result.delivered, failedCount: result.failed, skippedCount: result.skipped, updatedAt: now }).where(eq(schema.retentionCampaigns.id, campaignId));
  return result;
}

async function loadCampaign(ctx: ServiceContext, campaignId: string) {
  const [c] = await ctx.tx.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
  if (!c) throw new RetentionCampaignError("not_found");
  return c;
}

export interface CampaignResults {
  report: UpliftReport;
  windowEndsAt: Date;
  windowOpen: boolean;
  /** Treated converters whose order used the campaign's code. */
  codeRedemptions: number;
}

/**
 * Intention-to-treat results: every exposed customer counts in their group, with the sale-scope
 * orders they placed within the attribution window after exposure (economics as in the P/L).
 */
export async function retentionCampaignResults(ctx: ServiceContext, tenant: AnalyticsTenant, campaignId: string): Promise<CampaignResults | null> {
  const c = await loadCampaign(ctx, campaignId);
  if (c.status !== "sent" || !c.sentAt) return null;
  const now = ctx.now ?? new Date();
  const windowEndsAt = new Date(c.sentAt.getTime() + c.attributionDays * DAY);
  const exposures = await ctx.tx.select({ customerId: schema.retentionExposures.customerId, groupName: schema.retentionExposures.groupName, exposedAt: schema.retentionExposures.exposedAt }).from(schema.retentionExposures).where(eq(schema.retentionExposures.campaignId, campaignId));
  const hits = await ctx.tx.execute<{ id: string; customer_id: string }>(sql`
    select o.id, o.customer_id from orders o
    join retention_exposures e on e.customer_id = o.customer_id and e.campaign_id = ${campaignId}
    where o.tenant_id = ${ctx.tenantId} and o.placed_at > e.exposed_at and o.placed_at <= e.exposed_at + make_interval(days => ${c.attributionDays})`);
  const economics = hits.rows.length ? await orderEconomicsForPeriod(ctx, tenant, { from: c.sentAt, to: new Date(windowEndsAt.getTime() + DAY) }, { orderIds: hits.rows.map((h) => h.id) }) : [];
  const byCustomer = new Map<string, CustomerOutcome>();
  for (const e of economics) {
    if (!e.inScope || !e.customerId) continue;
    const o = byCustomer.get(e.customerId) ?? { orders: 0, revenueMinor: 0, marginMinor: 0 };
    o.orders++;
    o.revenueMinor += e.netRevenueMinor;
    o.marginMinor += e.marginMinor;
    byCustomer.set(e.customerId, o);
  }
  const none: CustomerOutcome = { orders: 0, revenueMinor: 0, marginMinor: 0 };
  const treated = exposures.filter((x) => x.groupName === "treated").map((x) => byCustomer.get(x.customerId) ?? none);
  const holdout = exposures.filter((x) => x.groupName === "holdout").map((x) => byCustomer.get(x.customerId) ?? none);
  let codeRedemptions = 0;
  if (c.discountCode && hits.rows.length) {
    const r = await ctx.tx.execute<{ n: number }>(sql`select count(distinct d.order_id)::int as n from order_discounts d where d.tenant_id = ${ctx.tenantId} and upper(d.code) = upper(${c.discountCode}) and d.order_id = any(${sql.param(hits.rows.map((h) => h.id))}::uuid[])`);
    codeRedemptions = r.rows[0]?.n ?? 0;
  }
  return { report: campaignUplift(treated, holdout, c.deliveredCount * c.costPerMessageMinor), windowEndsAt, windowOpen: now < windowEndsAt, codeRedemptions };
}

export interface RetentionCampaignRow {
  id: string;
  name: string;
  segmentId: string | null;
  segmentName: string | null;
  channel: string;
  status: string;
  sentAt: Date | null;
  treatedCount: number;
  holdoutCount: number;
  createdAt: Date;
  results: CampaignResults | null;
}

export async function listRetentionCampaigns(ctx: ServiceContext, tenant: AnalyticsTenant): Promise<RetentionCampaignRow[]> {
  const rows = await ctx.tx
    .select({ c: schema.retentionCampaigns, segmentName: schema.segments.name })
    .from(schema.retentionCampaigns)
    .leftJoin(schema.segments, eq(schema.segments.id, schema.retentionCampaigns.segmentId))
    .where(eq(schema.retentionCampaigns.tenantId, ctx.tenantId))
    .orderBy(desc(schema.retentionCampaigns.createdAt))
    .limit(100);
  const out: RetentionCampaignRow[] = [];
  for (const { c, segmentName } of rows) {
    out.push({ id: c.id, name: c.name, segmentId: c.segmentId, segmentName, channel: c.channel, status: c.status, sentAt: c.sentAt, treatedCount: c.treatedCount, holdoutCount: c.holdoutCount, createdAt: c.createdAt, results: c.status === "sent" ? await retentionCampaignResults(ctx, tenant, c.id) : null });
  }
  return out;
}

export interface RetentionCampaignDetail {
  campaign: typeof schema.retentionCampaigns.$inferSelect;
  segment: { id: string; name: string; holdoutPercentage: number } | null;
  results: CampaignResults | null;
  exposureStatus: { status: string; group: string; n: number }[];
}

export async function retentionCampaignDetail(ctx: ServiceContext, tenant: AnalyticsTenant, campaignId: string): Promise<RetentionCampaignDetail | null> {
  const [c] = await ctx.tx.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
  if (!c) return null;
  const [segment] = c.segmentId ? await ctx.tx.select({ id: schema.segments.id, name: schema.segments.name, holdoutPercentage: schema.segments.holdoutPercentage }).from(schema.segments).where(eq(schema.segments.id, c.segmentId)).limit(1) : [];
  const status = await ctx.tx.execute<{ status: string; group_name: string; n: number }>(sql`select status, group_name, count(*)::int as n from retention_exposures where campaign_id = ${campaignId} group by 1, 2 order by 2, 1`);
  return { campaign: c, segment: segment ?? null, results: await retentionCampaignResults(ctx, tenant, campaignId), exposureStatus: status.rows.map((r) => ({ status: r.status, group: r.group_name, n: Number(r.n) })) };
}
