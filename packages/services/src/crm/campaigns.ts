import { and, desc, eq, inArray, schema, sql } from "@hullwise/db";
import { TENANT_ROLES, canDo, type TenantRole } from "@hullwise/config";
import { SALE_STATUSES, RETENTION_CAMPAIGN_KINDS, RETENTION_CHANNELS, campaignUplift, canApproveCampaign, isCampaignEditable, nextCampaignStatus, type RetentionCampaignAction, type CustomerOutcome, type RetentionCampaignKind, type RetentionCampaignStatus, type RetentionChannel, type UpliftReport } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";
import { membersWithRoles } from "../notifications/system";
import { notifyUsers } from "../notifications";
import { evaluateSegment } from "./index";

const DAY = 864e5;

export class RetentionCampaignError extends Error {
  constructor(public readonly code: "not_found" | "not_editable" | "no_segment" | "empty_segment" | "invalid_input" | "invalid_transition" | "not_allowed" | "own_campaign" | "sequence_needs_holdout" | "manual_channel" | "no_recipients") {
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
  /** one_off (default) or sequence (always-on, messaging segment entrants). */
  kind?: RetentionCampaignKind;
  excludeOpenOrders?: boolean;
}

export type RetentionCampaign = typeof schema.retentionCampaigns.$inferSelect;

export async function saveRetentionCampaign(ctx: ServiceContext, input: RetentionCampaignInput, campaignId?: string): Promise<string> {
  const kind = input.kind ?? "one_off";
  if (!RETENTION_CHANNELS.includes(input.channel) || !RETENTION_CAMPAIGN_KINDS.includes(kind) || input.attributionDays < 1 || input.attributionDays > 90 || input.costPerMessageMinor < 0) throw new RetentionCampaignError("invalid_input");
  // a sequence sends by itself: Hullwise must deliver it, and its control group must exist to be permanent
  if (kind === "sequence" && input.channel === "manual") throw new RetentionCampaignError("invalid_input");
  const [segment] = await ctx.tx.select({ id: schema.segments.id, holdout: schema.segments.holdoutPercentage }).from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, input.segmentId))).limit(1);
  if (!segment) throw new RetentionCampaignError("no_segment");
  if (kind === "sequence" && segment.holdout <= 0) throw new RetentionCampaignError("sequence_needs_holdout");
  const values = { name: input.name, segmentId: input.segmentId, channel: input.channel, message: input.message, discountCode: input.discountCode || null, costPerMessageMinor: Math.round(input.costPerMessageMinor), attributionDays: Math.round(input.attributionDays), kind, excludeOpenOrders: input.excludeOpenOrders ?? true };
  if (campaignId) {
    const current = await loadCampaign(ctx, campaignId);
    if (!isCampaignEditable(current.status)) throw new RetentionCampaignError("not_editable");
    await ctx.tx.update(schema.retentionCampaigns).set({ ...values, updatedAt: new Date() }).where(eq(schema.retentionCampaigns.id, campaignId));
    return campaignId;
  }
  const [row] = await ctx.tx.insert(schema.retentionCampaigns).values({ tenantId: ctx.tenantId, ...values, createdBy: ctx.actor.userId }).returning({ id: schema.retentionCampaigns.id });
  return row!.id;
}

export async function deleteRetentionCampaign(ctx: ServiceContext, campaignId: string): Promise<void> {
  const current = await loadCampaign(ctx, campaignId);
  if (!isCampaignEditable(current.status)) throw new RetentionCampaignError("not_editable");
  await ctx.tx.delete(schema.retentionCampaigns).where(eq(schema.retentionCampaigns.id, campaignId));
}

export async function loadCampaign(ctx: ServiceContext, campaignId: string, opts: { lock?: boolean } = {}): Promise<RetentionCampaign> {
  const q = ctx.tx.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
  const [c] = opts.lock ? await q.for("update") : await q;
  if (!c) throw new RetentionCampaignError("not_found");
  return c;
}

/* ---------- approval workflow (#34) ---------- */

export interface CampaignTransition {
  campaign: RetentionCampaign;
  from: string;
  to: RetentionCampaignStatus;
}

async function transition(ctx: ServiceContext, campaignId: string, action: RetentionCampaignAction, patch: (c: RetentionCampaign) => Partial<typeof schema.retentionCampaigns.$inferInsert> = () => ({})): Promise<CampaignTransition> {
  const c = await loadCampaign(ctx, campaignId, { lock: true });
  const to = nextCampaignStatus(c.kind as RetentionCampaignKind, c.status, action);
  if (!to) throw new RetentionCampaignError("invalid_transition");
  const now = ctx.now ?? new Date();
  const [updated] = await ctx.tx.update(schema.retentionCampaigns).set({ status: to, updatedAt: now, ...patch(c) }).where(eq(schema.retentionCampaigns.id, c.id)).returning();
  return { campaign: updated!, from: c.status, to };
}

/** Roles the matrix lets approve campaigns (owner, admin, and whoever has write on the campaigns page). */
export const campaignApproverRoles = (): TenantRole[] => TENANT_ROLES.filter((r) => canDo(r, "approve_customer_campaign"));

const link = (id: string) => `/segments/campaigns/${id}`;
const authorsOf = (c: RetentionCampaign) => [...new Set([c.submittedBy, c.createdBy].filter((x): x is string => Boolean(x)))];

/** Draft → waiting for approval; every possible approver but the author is notified. Manual campaigns are recorded, not approved. */
export async function submitRetentionCampaign(ctx: ServiceContext, campaignId: string): Promise<CampaignTransition> {
  const current = await loadCampaign(ctx, campaignId);
  if (current.channel === "manual") throw new RetentionCampaignError("manual_channel");
  if (!current.segmentId) throw new RetentionCampaignError("no_segment");
  const r = await transition(ctx, campaignId, "submit", () => ({ submittedAt: ctx.now ?? new Date(), submittedBy: ctx.actor.userId, reviewNote: null, approvedAt: null, approvedBy: null }));
  const approvers = (await membersWithRoles(ctx, campaignApproverRoles())).filter((u) => u !== ctx.actor.userId);
  await notifyUsers(ctx, { userIds: approvers, type: "customer_campaign", title: r.campaign.name, body: "approval_requested", link: link(campaignId), metadata: { event: "approval_requested", campaignId } });
  return r;
}

/**
 * Waiting → approved. The approver needs the approval permission of the role matrix and cannot be
 * the author (who created or submitted the campaign), unless they are the owner.
 */
export async function approveRetentionCampaign(ctx: ServiceContext, campaignId: string, input: { role: TenantRole; note?: string | null }): Promise<CampaignTransition> {
  const current = await loadCampaign(ctx, campaignId);
  const isAuthor = ctx.actor.userId !== null && authorsOf(current).includes(ctx.actor.userId);
  const roleCanApprove = canDo(input.role, "approve_customer_campaign");
  if (!canApproveCampaign({ roleCanApprove, isOwner: input.role === "owner", isAuthor })) throw new RetentionCampaignError(roleCanApprove ? "own_campaign" : "not_allowed");
  const r = await transition(ctx, campaignId, "approve", () => ({ approvedAt: ctx.now ?? new Date(), approvedBy: ctx.actor.userId, reviewNote: input.note ?? null }));
  await notifyUsers(ctx, { userIds: authorsOf(r.campaign).filter((u) => u !== ctx.actor.userId), type: "customer_campaign", title: r.campaign.name, body: "approved", link: link(campaignId), severity: "success", metadata: { event: "approved", campaignId } });
  return r;
}

/** Waiting → draft with the reviewer's note. */
export async function rejectRetentionCampaign(ctx: ServiceContext, campaignId: string, input: { role: TenantRole; note: string }): Promise<CampaignTransition> {
  if (!canDo(input.role, "approve_customer_campaign")) throw new RetentionCampaignError("not_allowed");
  const r = await transition(ctx, campaignId, "reject", () => ({ reviewNote: input.note, approvedAt: null, approvedBy: null }));
  await notifyUsers(ctx, { userIds: authorsOf(r.campaign).filter((u) => u !== ctx.actor.userId), type: "customer_campaign", title: r.campaign.name, body: "rejected", link: link(campaignId), severity: "warning", metadata: { event: "rejected", campaignId, note: input.note } });
  return r;
}

/** Back to draft to change it (a waiting, approved, scheduled or paused campaign): it needs a new approval. */
export async function reopenRetentionCampaign(ctx: ServiceContext, campaignId: string): Promise<CampaignTransition> {
  return transition(ctx, campaignId, "reopen", () => ({ approvedAt: null, approvedBy: null, scheduledAt: null, scheduledBy: null }));
}

/** Approved → scheduled for `at` (now when null); the job starts it then, or at the next opening of the send window. */
export async function scheduleRetentionCampaign(ctx: ServiceContext, campaignId: string, at: Date | null): Promise<CampaignTransition> {
  const now = ctx.now ?? new Date();
  return transition(ctx, campaignId, "schedule", () => ({ scheduledAt: at ?? now, scheduledBy: ctx.actor.userId }));
}

export async function unscheduleRetentionCampaign(ctx: ServiceContext, campaignId: string): Promise<CampaignTransition> {
  return transition(ctx, campaignId, "unschedule", () => ({ scheduledAt: null, scheduledBy: null }));
}

/**
 * Approved or paused sequence → active. The segment is switched to live updates (entrants are
 * found by the live refresh); the measurement starts with the first activation.
 */
export async function activateSequence(ctx: ServiceContext, campaignId: string): Promise<CampaignTransition> {
  const now = ctx.now ?? new Date();
  const r = await transition(ctx, campaignId, "activate", (c) => ({ sentAt: c.sentAt ?? now, sentBy: c.sentBy ?? ctx.actor.userId }));
  if (r.campaign.segmentId) {
    await ctx.tx.update(schema.segments).set({ liveUpdates: true }).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, r.campaign.segmentId)));
    await evaluateSegment(ctx, r.campaign.segmentId);
  }
  return r;
}

export async function pauseSequence(ctx: ServiceContext, campaignId: string): Promise<CampaignTransition> {
  return transition(ctx, campaignId, "pause");
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
/** A campaign has results once customers were exposed: a one-off from its send start, a sequence from its first activation. */
export const hasCampaignResults = (c: Pick<RetentionCampaign, "status" | "sentAt">) => c.sentAt !== null && ["sending", "sent", "active", "paused"].includes(c.status);

export async function retentionCampaignResults(ctx: ServiceContext, tenant: AnalyticsTenant, campaignId: string): Promise<CampaignResults | null> {
  const c = await loadCampaign(ctx, campaignId);
  if (!hasCampaignResults(c) || !c.sentAt) return null;
  const now = ctx.now ?? new Date();
  const exposures = await ctx.tx.select({ customerId: schema.retentionExposures.customerId, groupName: schema.retentionExposures.groupName, exposedAt: schema.retentionExposures.exposedAt }).from(schema.retentionExposures).where(eq(schema.retentionExposures.campaignId, campaignId));
  // a sequence keeps enrolling: its window closes with the last entrant's
  const lastExposure = exposures.reduce((m, x) => Math.max(m, x.exposedAt.getTime()), c.sentAt.getTime());
  const windowEndsAt = new Date((c.kind === "sequence" ? lastExposure : c.sentAt.getTime()) + c.attributionDays * DAY);
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
  return { report: campaignUplift(treated, holdout, c.deliveredCount * c.costPerMessageMinor), windowEndsAt, windowOpen: c.status === "active" || now < windowEndsAt, codeRedemptions };
}

export interface RetentionCampaignRow {
  id: string;
  name: string;
  segmentId: string | null;
  segmentName: string | null;
  channel: string;
  kind: string;
  status: string;
  sentAt: Date | null;
  scheduledAt: Date | null;
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
    out.push({ id: c.id, name: c.name, segmentId: c.segmentId, segmentName, channel: c.channel, kind: c.kind, status: c.status, sentAt: c.sentAt, scheduledAt: c.scheduledAt, treatedCount: c.treatedCount, holdoutCount: c.holdoutCount, createdAt: c.createdAt, results: hasCampaignResults(c) ? await retentionCampaignResults(ctx, tenant, c.id) : null });
  }
  return out;
}

export interface RetentionCampaignDetail {
  campaign: typeof schema.retentionCampaigns.$inferSelect;
  segment: { id: string; name: string; holdoutPercentage: number } | null;
  results: CampaignResults | null;
  exposureStatus: { status: string; group: string; n: number }[];
  /** Messages of the treated group: to send (queued + in flight) and done (sent, failed, skipped, suppressed). */
  progress: { total: number; pending: number; sent: number; failed: number; skipped: number; suppressed: number };
  people: { createdBy: string | null; submittedBy: string | null; approvedBy: string | null; scheduledBy: string | null; testSentBy: string | null };
}

export async function retentionCampaignDetail(ctx: ServiceContext, tenant: AnalyticsTenant, campaignId: string): Promise<RetentionCampaignDetail | null> {
  const [c] = await ctx.tx.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
  if (!c) return null;
  const [segment] = c.segmentId ? await ctx.tx.select({ id: schema.segments.id, name: schema.segments.name, holdoutPercentage: schema.segments.holdoutPercentage }).from(schema.segments).where(eq(schema.segments.id, c.segmentId)).limit(1) : [];
  const status = await ctx.tx.execute<{ status: string; group_name: string; n: number }>(sql`select status, group_name, count(*)::int as n from retention_exposures where campaign_id = ${campaignId} group by 1, 2 order by 2, 1`);
  const exposureStatus = status.rows.map((r) => ({ status: r.status, group: r.group_name, n: Number(r.n) }));
  const count = (...st: string[]) => exposureStatus.filter((x) => x.group === "treated" && st.includes(x.status)).reduce((a, x) => a + x.n, 0);
  const progress = { total: count("queued", "sending", "sent", "failed", "skipped", "suppressed"), pending: count("queued", "sending"), sent: count("sent"), failed: count("failed"), skipped: count("skipped"), suppressed: count("suppressed") };
  const ids = [c.createdBy, c.submittedBy, c.approvedBy, c.scheduledBy, c.testSentBy].filter((x): x is string => Boolean(x));
  const names = new Map(ids.length ? (await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.name ?? u.email]) : []);
  const who = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return { campaign: c, segment: segment ?? null, results: await retentionCampaignResults(ctx, tenant, campaignId), exposureStatus, progress, people: { createdBy: who(c.createdBy), submittedBy: who(c.submittedBy), approvedBy: who(c.approvedBy), scheduledBy: who(c.scheduledBy), testSentBy: who(c.testSentBy) } };
}

export interface CampaignRecipient {
  customerId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  group: string;
  status: string;
  exposedAt: Date;
  sentAt: Date | null;
  error: string | null;
  /** Sale-scope orders placed within the attribution window after exposure (what the results count). */
  orders: number;
}

/**
 * Who a campaign reached, page by page: each exposed customer with their group (treated or control),
 * the message status and whether they ordered within the attribution window, so the control group
 * is something one can look at, not only a number. Filter by group; treated first, then by name.
 */
export async function campaignRecipients(ctx: ServiceContext, campaignId: string, f: { group?: "treated" | "holdout" | null; limit?: number; offset?: number } = {}): Promise<{ rows: CampaignRecipient[]; total: number; byGroup: Record<string, number> }> {
  const c = await loadCampaign(ctx, campaignId);
  const limit = Math.min(f.limit ?? 25, 100);
  const group = f.group ? sql`and e.group_name = ${f.group}` : sql``;
  const counts = (await ctx.tx.execute<{ group_name: string; n: number }>(sql`select group_name, count(*)::int as n from retention_exposures where tenant_id = ${ctx.tenantId} and campaign_id = ${c.id} group by 1`)).rows;
  const byGroup = Object.fromEntries(counts.map((r) => [r.group_name, Number(r.n)]));
  const rows = (await ctx.tx.execute<{ customer_id: string; first_name: string | null; last_name: string | null; email: string | null; phone_e164: string | null; group_name: string; status: string; exposed_at: Date | string; sent_at: Date | string | null; error: string | null; orders: number }>(sql`
    select e.customer_id, cu.first_name, cu.last_name, cu.email, cu.phone_e164, e.group_name, e.status, e.exposed_at, e.sent_at, e.error,
      (select count(*)::int from orders o where o.tenant_id = e.tenant_id and o.customer_id = e.customer_id and o.placed_at > e.exposed_at and o.placed_at <= e.exposed_at + make_interval(days => ${c.attributionDays}) and o.status = any(${sql.param([...SALE_STATUSES])}::text[])) as orders
    from retention_exposures e join customers cu on cu.id = e.customer_id
    where e.tenant_id = ${ctx.tenantId} and e.campaign_id = ${c.id} ${group}
    order by e.group_name = 'holdout', orders desc, cu.last_name nulls last, cu.first_name nulls last, e.customer_id
    limit ${limit} offset ${Math.max(0, f.offset ?? 0)}`)).rows;
  return {
    byGroup,
    total: f.group ? (byGroup[f.group] ?? 0) : counts.reduce((a, r) => a + Number(r.n), 0),
    rows: rows.map((r) => ({ customerId: r.customer_id, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null, email: r.email, phone: r.phone_e164, group: r.group_name, status: r.status, exposedAt: new Date(r.exposed_at), sentAt: r.sent_at ? new Date(r.sent_at) : null, error: r.error, orders: Number(r.orders) })),
  };
}
