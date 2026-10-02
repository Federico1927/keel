import { and, eq, inArray, recordAudit, schema, sql } from "@hullwise/db";
import { CAMPAIGN_SEND_MAX_ATTEMPTS, OPEN_STATUSES, campaignExclusion, campaignMessageKey, campaignRetryDelayMs, emptyExclusionCounts, isCampaignDelivering, isInSendWindow, minimumDetectableUplift, nextSendWindowStart, renderMessage, throttleAllowance, type CampaignExclusionReason, type ExclusionCounts, type RetentionCampaignKind, type SendWindow, type TenantSettings } from "@hullwise/core";
import { IntegrationError, type MessagingChannel } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import type { TenantRunner } from "../assistant";
import { suppressedContacts } from "../email/suppressions";
import { notifyUsers } from "../notifications";
import { evaluateSegment } from "./index";
import { RetentionCampaignError, loadCampaign, type RetentionCampaign } from "./campaigns";

/**
 * Customer campaign delivery (#34): audience with exclusions, the send snapshot, the asynchronous
 * send queue and always-on sequences. Every treated customer gets one exposure row; for messaging
 * channels it is also the queue entry (status queued → sending → sent / failed / suppressed),
 * keyed by campaign × customer × channel so a batch resent after a crash reaches the provider once.
 */

const DAY = 864e5;
const OPEN = OPEN_STATUSES as readonly string[];
/** A claimed message still `sending` after this long belongs to a worker that died: it goes back in line (same key). */
export const STALE_CLAIM_MS = 5 * 60_000;
const BATCH = 200;
const RETRYABLE: IntegrationError["code"][] = ["rate_limited", "network", "unknown"];

export interface CampaignTenant {
  id: string;
  timezone: string;
  settings: TenantSettings;
}

export const sendWindowOf = (tenant: Pick<CampaignTenant, "timezone" | "settings">): SendWindow => ({ startHour: tenant.settings.campaignSendStartHour, endHour: tenant.settings.campaignSendEndHour, timeZone: tenant.timezone });

/* ---------- audience ---------- */

interface Candidate {
  customerId: string;
  group: "treated" | "holdout";
  firstName: string | null;
  email: string | null;
  phone: string | null;
  reason: CampaignExclusionReason | null;
}

/**
 * Segment members with the reason each one is left out, if any. Reasons other than the control
 * group apply to both groups alike, so treated and control stay comparable. `onlyNew` (sequences)
 * keeps members never exposed to this campaign.
 */
async function campaignCandidates(ctx: ServiceContext, c: RetentionCampaign, settings: TenantSettings, now: Date, opts: { onlyNew?: boolean } = {}): Promise<Candidate[]> {
  if (!c.segmentId) throw new RetentionCampaignError("no_segment");
  const t = ctx.tenantId;
  const capSince = new Date(now.getTime() - settings.campaignFrequencyDays * DAY);
  const rows = await ctx.tx.execute<{ customer_id: string; group_name: string; first_name: string | null; email: string | null; phone_e164: string | null; accepts_marketing: boolean; recent: number; open_order: boolean; in_measurement: boolean }>(sql`
    select m.customer_id, m.group_name, c.first_name, c.email, c.phone_e164, c.accepts_marketing,
      coalesce(fc.n, 0)::int as recent,
      exists (select 1 from orders o where o.tenant_id = ${t} and o.customer_id = m.customer_id and o.replaced_by_order_id is null and o.status in ${OPEN}) as open_order,
      exists (
        select 1 from retention_exposures e join retention_campaigns rc on rc.id = e.campaign_id
        where e.tenant_id = ${t} and e.customer_id = m.customer_id and e.campaign_id <> ${c.id}
          and rc.status in ('sending', 'sent', 'active', 'paused') and e.exposed_at + make_interval(days => rc.attribution_days) > ${now}
      ) as in_measurement
    from segment_memberships m join customers c on c.id = m.customer_id
    left join (
      select customer_id, count(*) as n from retention_exposures
      where tenant_id = ${t} and status = 'sent' and coalesce(sent_at, exposed_at) > ${capSince} group by 1
    ) fc on fc.customer_id = m.customer_id
    where m.tenant_id = ${t} and m.segment_id = ${c.segmentId}
      ${opts.onlyNew ? sql`and not exists (select 1 from retention_exposures x where x.campaign_id = ${c.id} and x.customer_id = m.customer_id)` : sql``}
    order by m.customer_id`);
  const suppressed = await suppressedContacts(ctx, rows.rows.map((r) => ({ customerId: r.customer_id, email: r.email, phone: r.phone_e164 })));
  const rules = { frequencyCap: settings.campaignFrequencyCap, excludeOpenOrders: c.excludeOpenOrders, measurementLock: settings.campaignMeasurementLock };
  return rows.rows.map((r) => {
    const group = r.group_name === "holdout" ? "holdout" : "treated";
    return {
      customerId: r.customer_id, group, firstName: r.first_name, email: r.email, phone: r.phone_e164,
      reason: campaignExclusion({ acceptsMarketing: r.accepts_marketing, suppressed: suppressed.has(r.customer_id), recentMessages: Number(r.recent), hasOpenOrder: r.open_order, inMeasurement: r.in_measurement, group }, rules),
    };
  });
}

const addressFor = (channel: string, p: { email: string | null; phone: string | null }) => (channel === "email" ? p.email : channel === "sms" || channel === "whatsapp" ? p.phone : null);

function countReasons(people: readonly Candidate[]): ExclusionCounts {
  const out = emptyExclusionCounts();
  for (const p of people) if (p.reason) out[p.reason]++;
  return out;
}

export interface SendPreview {
  /** Members of the segment now (sequences: members not yet enrolled). */
  members: number;
  /** Customers who would be messaged, and the control group recorded with them. */
  treated: number;
  holdout: number;
  holdoutPercentage: number;
  /** Members left out, by reason (`holdout` = the control group). */
  exclusions: ExclusionCounts;
  /** Treated customers without an address for the channel: recorded as skipped. */
  noAddress: number;
  /** Repeat-purchase rate of the audience over a past window of the same length, as the expected baseline. */
  baselineRate: number | null;
  minimumDetectableUplift: number | null;
}

/** What sending would do now. A one-off re-evaluates its segment first, as the send does (groups of existing members never move). */
export async function previewRetentionSend(ctx: ServiceContext, campaignId: string, settings: TenantSettings): Promise<SendPreview> {
  const c = await loadCampaign(ctx, campaignId);
  if (!c.segmentId) throw new RetentionCampaignError("no_segment");
  if (c.kind !== "sequence") await evaluateSegment(ctx, c.segmentId);
  const [segment] = await ctx.tx.select({ holdout: schema.segments.holdoutPercentage }).from(schema.segments).where(eq(schema.segments.id, c.segmentId)).limit(1);
  const now = ctx.now ?? new Date();
  const people = await campaignCandidates(ctx, c, settings, now, { onlyNew: c.kind === "sequence" });
  const eligible = people.filter((p) => p.reason === null || p.reason === "holdout");
  const treated = eligible.filter((p) => p.reason === null);
  const holdout = eligible.length - treated.length;
  const since = new Date(now.getTime() - c.attributionDays * DAY);
  const ids = eligible.map((p) => p.customerId);
  let baselineRate: number | null = null;
  if (ids.length) {
    const r = await ctx.tx.execute<{ n: number }>(sql`select count(distinct customer_id)::int as n from orders where tenant_id = ${ctx.tenantId} and customer_id = any(${sql.param(ids)}::uuid[]) and placed_at > ${since} and status in ('confirmed', 'fulfilling', 'shipped', 'delivered', 'returned_partial')`);
    baselineRate = (r.rows[0]?.n ?? 0) / ids.length;
  }
  return {
    members: people.length, treated: treated.length, holdout, holdoutPercentage: segment?.holdout ?? 0, exclusions: countReasons(people),
    noAddress: c.channel === "manual" ? 0 : treated.filter((p) => !addressFor(c.channel, p)).length,
    baselineRate, minimumDetectableUplift: baselineRate === null ? null : minimumDetectableUplift(Math.max(baselineRate, 0.005), treated.length, holdout),
  };
}

/* ---------- send start (snapshot) ---------- */

type ExposureInsert = typeof schema.retentionExposures.$inferInsert;

function exposureRows(ctx: ServiceContext, c: RetentionCampaign, people: readonly Candidate[], now: Date): ExposureInsert[] {
  const rows: ExposureInsert[] = [];
  for (const p of people) {
    if (p.reason !== null && p.reason !== "holdout") continue;
    const base = { tenantId: ctx.tenantId, campaignId: c.id, customerId: p.customerId, groupName: p.group, exposedAt: now };
    if (p.reason === "holdout") rows.push({ ...base, status: "held_out" });
    else if (c.channel === "manual") rows.push({ ...base, status: "sent", sentAt: now });
    else if (!addressFor(c.channel, p)) rows.push({ ...base, status: "skipped" });
    else rows.push({ ...base, status: "queued", idempotencyKey: campaignMessageKey(c.id, p.customerId, c.channel) });
  }
  return rows;
}

async function insertExposures(ctx: ServiceContext, rows: readonly ExposureInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) await ctx.tx.insert(schema.retentionExposures).values(rows.slice(i, i + 1000)).onConflictDoNothing();
}

/** Counters on the campaign row, recomputed from its exposures (crash-safe: never incremented). */
async function refreshCounters(ctx: ServiceContext, campaignId: string): Promise<{ pending: number }> {
  const [r] = (await ctx.tx.execute<{ t: number; h: number; d: number; f: number; s: number; p: number }>(sql`
    select count(*) filter (where group_name = 'treated')::int as t, count(*) filter (where group_name = 'holdout')::int as h,
      count(*) filter (where status = 'sent')::int as d, count(*) filter (where status = 'failed')::int as f,
      count(*) filter (where status in ('skipped', 'suppressed'))::int as s, count(*) filter (where status in ('queued', 'sending'))::int as p
    from retention_exposures where campaign_id = ${campaignId}`)).rows;
  await ctx.tx.update(schema.retentionCampaigns).set({ treatedCount: r?.t ?? 0, holdoutCount: r?.h ?? 0, deliveredCount: r?.d ?? 0, failedCount: r?.f ?? 0, skippedCount: r?.s ?? 0 }).where(eq(schema.retentionCampaigns.id, campaignId));
  return { pending: r?.p ?? 0 };
}

/**
 * Starts a one-off: re-evaluates the segment, snapshots the audience into exposures (control group
 * held out, excluded members left out and counted by reason), opens the measurement window and
 * hands the treated messages to the queue. A manual campaign is recorded as sent at once.
 */
export async function startCampaignSend(ctx: ServiceContext, campaignId: string, settings: TenantSettings): Promise<{ started: boolean; queued: number }> {
  const c = await loadCampaign(ctx, campaignId, { lock: true });
  const manualRecord = c.channel === "manual" && c.status === "draft";
  if (!manualRecord && c.status !== "scheduled") return { started: false, queued: 0 };
  if (!c.segmentId) throw new RetentionCampaignError("no_segment");
  const now = ctx.now ?? new Date();
  await evaluateSegment(ctx, c.segmentId);
  const people = await campaignCandidates(ctx, c, settings, now);
  const rows = exposureRows(ctx, c, people, now);
  if (manualRecord && !rows.length) throw new RetentionCampaignError("empty_segment");
  await insertExposures(ctx, rows);
  const queued = rows.filter((r) => r.status === "queued").length;
  const done = queued === 0;
  await ctx.tx.update(schema.retentionCampaigns).set({ status: done ? "sent" : "sending", sentAt: now, sentBy: c.sentBy ?? (manualRecord ? ctx.actor.userId : (c.scheduledBy ?? c.approvedBy)), exclusionCounts: countReasons(people), completedAt: done ? now : null, updatedAt: now }).where(eq(schema.retentionCampaigns.id, c.id));
  await refreshCounters(ctx, c.id);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", action: manualRecord ? "retention_campaign.recorded" : "retention_campaign.send_started", entityType: "retention_campaign", entityId: c.id, diff: { status: { from: c.status, to: done ? "sent" : "sending" } }, metadata: { exposures: rows.length, queued, exclusions: countReasons(people) } });
  if (done && !manualRecord) await notifySent(ctx, c);
  return { started: true, queued };
}

/** A manual campaign (sent from another tool): the exposures are recorded now, nothing is sent and no approval is needed. */
export async function recordManualCampaign(ctx: ServiceContext, campaignId: string, settings: TenantSettings): Promise<{ treated: number; holdout: number }> {
  const c = await loadCampaign(ctx, campaignId);
  if (c.channel !== "manual") throw new RetentionCampaignError("invalid_input");
  if (c.status !== "draft") throw new RetentionCampaignError("not_editable");
  await startCampaignSend(ctx, campaignId, settings);
  const after = await loadCampaign(ctx, campaignId);
  return { treated: after.treatedCount, holdout: after.holdoutCount };
}

/**
 * Sequences: members of the (live) segment never exposed to the sequence are enrolled now, with
 * their permanent group; excluded members wait and are counted by reason (they may qualify later).
 */
export async function enrollSequence(ctx: ServiceContext, campaignId: string, settings: TenantSettings): Promise<{ enrolled: number; queued: number }> {
  const c = await loadCampaign(ctx, campaignId, { lock: true });
  if (c.kind !== "sequence" || c.status !== "active") return { enrolled: 0, queued: 0 };
  const now = ctx.now ?? new Date();
  const people = await campaignCandidates(ctx, c, settings, now, { onlyNew: true });
  const rows = exposureRows(ctx, c, people, now);
  await insertExposures(ctx, rows);
  await ctx.tx.update(schema.retentionCampaigns).set({ exclusionCounts: countReasons(people.filter((p) => p.reason !== "holdout")), updatedAt: now }).where(eq(schema.retentionCampaigns.id, c.id));
  await refreshCounters(ctx, c.id);
  return { enrolled: rows.length, queued: rows.filter((r) => r.status === "queued").length };
}

async function notifySent(ctx: ServiceContext, c: RetentionCampaign): Promise<void> {
  const users = [...new Set([c.submittedBy, c.createdBy, c.approvedBy].filter((x): x is string => Boolean(x)))];
  await notifyUsers({ ...ctx, actor: { type: "system", userId: null } }, { userIds: users, type: "customer_campaign", title: c.name, body: "sent", link: `/segments/campaigns/${c.id}`, severity: "success", metadata: { event: "sent", campaignId: c.id } });
}

/* ---------- queue ---------- */

export interface CampaignSendOutcome {
  campaignId: string;
  status: "done" | "progress" | "throttled" | "outside_window" | "idle" | "skipped";
  sent: number;
  failed: number;
  suppressed: number;
  /** Messages still to send. */
  remaining: number;
  /** When it is worth trying again (throttle, window, retry backoff). */
  retryInMs?: number;
}

interface Claimed {
  id: string;
  customerId: string;
  key: string;
  to: string;
  firstName: string | null;
}

/**
 * Sends a campaign's queued messages, batch by batch, within the send window and the channel's
 * per-minute throttle, until nothing is due or the time budget is spent. Each batch is claimed in
 * a short transaction (row locks, `sending`), sent outside any transaction with the message's
 * idempotency key, then recorded. A worker killed mid-batch leaves rows `sending`: after
 * `STALE_CLAIM_MS` they are claimed again and resent with the same key, so the provider delivers
 * each message once. Suppression and consent are checked again at claim time: an unsubscribe that
 * arrives while a campaign is sending is honoured.
 */
export async function processCampaignSend(run: TenantRunner, tenant: CampaignTenant, campaignId: string, channel: MessagingChannel, opts: { now?: Date; budgetMs?: number } = {}): Promise<CampaignSendOutcome> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 25_000;
  const total = { sent: 0, failed: 0, suppressed: 0 };
  const window = sendWindowOf(tenant);
  for (;;) {
    const now = opts.now ?? new Date();
    const claim = await run(async (ctx): Promise<{ kind: "stop"; outcome: CampaignSendOutcome } | { kind: "claimed"; c: RetentionCampaign; rows: Claimed[] }> => {
      const stop = (status: CampaignSendOutcome["status"], remaining: number, retryInMs?: number) => ({ kind: "stop" as const, outcome: { campaignId, status, ...total, remaining, retryInMs } });
      // one worker per campaign at a time; the others skip it
      const [c] = await ctx.tx.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), eq(schema.retentionCampaigns.id, campaignId))).limit(1).for("update", { skipLocked: true });
      if (!c || !isCampaignDelivering(c.kind as RetentionCampaignKind, c.status)) return stop("skipped", 0);
      await ctx.tx.update(schema.retentionExposures).set({ status: "queued", claimedAt: null }).where(and(eq(schema.retentionExposures.campaignId, c.id), eq(schema.retentionExposures.status, "sending"), sql`${schema.retentionExposures.claimedAt} < ${new Date(now.getTime() - STALE_CLAIM_MS)}`));
      const [pending] = (await ctx.tx.execute<{ n: number; due: number; next: Date | string | null }>(sql`select count(*)::int as n, count(*) filter (where status = 'queued' and (next_attempt_at is null or next_attempt_at <= ${now}))::int as due, min(next_attempt_at) filter (where status = 'queued') as next from retention_exposures where campaign_id = ${c.id} and status in ('queued', 'sending')`)).rows;
      const remaining = pending?.n ?? 0;
      if (!remaining) {
        if (c.kind !== "sequence" && c.status === "sending") {
          await ctx.tx.update(schema.retentionCampaigns).set({ status: "sent", completedAt: now, updatedAt: now }).where(eq(schema.retentionCampaigns.id, c.id));
          await refreshCounters(ctx, c.id);
          await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "retention_campaign.sent", entityType: "retention_campaign", entityId: c.id, diff: { status: { from: "sending", to: "sent" } }, metadata: { delivered: c.deliveredCount } });
          await notifySent(ctx, c);
          return stop("done", 0);
        }
        return stop("idle", 0);
      }
      if (!isInSendWindow(now, window)) return stop("outside_window", remaining, nextSendWindowStart(now, window).getTime() - now.getTime());
      if (!pending?.due) {
        const next = pending?.next ? new Date(pending.next).getTime() - now.getTime() : 60_000;
        return stop("progress", remaining, Math.max(1000, next));
      }
      // the throttle is per tenant and channel: claims are serialised so two campaigns never exceed it together
      await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`campaign-throttle:${ctx.tenantId}:${c.channel}`}))`);
      const minuteAgo = new Date(now.getTime() - 60_000);
      const [recent] = (await ctx.tx.execute<{ n: number }>(sql`
        select count(*)::int as n from retention_exposures e join retention_campaigns rc on rc.id = e.campaign_id
        where e.tenant_id = ${ctx.tenantId} and rc.channel = ${c.channel}
          and ((e.status = 'sent' and e.sent_at > ${minuteAgo}) or (e.status = 'sending' and e.claimed_at > ${minuteAgo}))`)).rows;
      const limit = tenant.settings.campaignThrottlePerMinute[c.channel as "email" | "sms" | "whatsapp"] ?? 60;
      const allowance = throttleAllowance(limit, recent?.n ?? 0);
      if (allowance <= 0) return stop("throttled", remaining, 60_000);
      const due = await ctx.tx.execute<{ id: string; customer_id: string; idempotency_key: string | null; first_name: string | null; email: string | null; phone_e164: string | null; accepts_marketing: boolean }>(sql`
        select e.id, e.customer_id, e.idempotency_key, c.first_name, c.email, c.phone_e164, c.accepts_marketing
        from retention_exposures e join customers c on c.id = e.customer_id
        where e.campaign_id = ${c.id} and e.status = 'queued' and (e.next_attempt_at is null or e.next_attempt_at <= ${now})
        order by e.customer_id limit ${Math.min(allowance, BATCH)} for update of e skip locked`);
      const suppressed = await suppressedContacts(ctx, due.rows.map((r) => ({ customerId: r.customer_id, email: r.email, phone: r.phone_e164 })));
      const blocked = due.rows.filter((r) => suppressed.has(r.customer_id) || !r.accepts_marketing);
      const noAddress = due.rows.filter((r) => !blocked.includes(r) && !addressFor(c.channel, { email: r.email, phone: r.phone_e164 }));
      const go = due.rows.filter((r) => !blocked.includes(r) && !noAddress.includes(r));
      if (blocked.length) await ctx.tx.update(schema.retentionExposures).set({ status: "suppressed", error: "suppressed_or_no_consent", claimedAt: null }).where(inArray(schema.retentionExposures.id, blocked.map((r) => r.id)));
      if (noAddress.length) await ctx.tx.update(schema.retentionExposures).set({ status: "skipped", claimedAt: null }).where(inArray(schema.retentionExposures.id, noAddress.map((r) => r.id)));
      if (go.length) await ctx.tx.update(schema.retentionExposures).set({ status: "sending", claimedAt: now, attempts: sql`${schema.retentionExposures.attempts} + 1` }).where(inArray(schema.retentionExposures.id, go.map((r) => r.id)));
      total.suppressed += blocked.length;
      return { kind: "claimed", c, rows: go.map((r) => ({ id: r.id, customerId: r.customer_id, key: r.idempotency_key ?? campaignMessageKey(c.id, r.customer_id, c.channel), to: addressFor(c.channel, { email: r.email, phone: r.phone_e164 })!, firstName: r.first_name })) };
    });
    if (claim.kind === "stop") return claim.outcome;
    const { c, rows } = claim;
    const results: { id: string; ok: boolean; messageId?: string; error?: string; retryable?: boolean; retryAfterMs?: number }[] = [];
    let rateLimited = false;
    for (const r of rows) {
      if (rateLimited) {
        results.push({ id: r.id, ok: false, error: "rate_limited", retryable: true });
        continue;
      }
      try {
        const vars = { first_name: r.firstName ?? "", code: c.discountCode ?? "" };
        const { messageId } = await channel.sendMessage({ to: r.to, template: renderMessage(c.message, vars), variables: vars, idempotencyKey: r.key, meta: { purpose: "campaign", campaignId: c.id, customerId: r.customerId } });
        results.push({ id: r.id, ok: true, messageId });
      } catch (e) {
        const code = e instanceof IntegrationError ? e.code : "unknown";
        if (code === "rate_limited") rateLimited = true;
        results.push({ id: r.id, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), retryable: RETRYABLE.includes(code), retryAfterMs: e instanceof IntegrationError ? e.retryAfterMs : undefined });
      }
    }
    await run(async (ctx) => {
      const at = opts.now ?? new Date();
      const ok = results.filter((r) => r.ok);
      if (ok.length) {
        await ctx.tx.execute(sql`
          update retention_exposures e set status = 'sent', message_id = v.mid, sent_at = ${at}, claimed_at = null, error = null, next_attempt_at = null
          from unnest(${sql.param(ok.map((r) => r.id))}::uuid[], ${sql.param(ok.map((r) => r.messageId ?? null))}::text[]) as v(id, mid)
          where e.id = v.id and e.status = 'sending'`);
      }
      const failures = results.filter((r) => !r.ok);
      const attempts = new Map(failures.length ? (await ctx.tx.select({ id: schema.retentionExposures.id, attempts: schema.retentionExposures.attempts }).from(schema.retentionExposures).where(inArray(schema.retentionExposures.id, failures.map((r) => r.id)))).map((r) => [r.id, r.attempts]) : []);
      for (const f of failures) {
        const n = attempts.get(f.id) ?? CAMPAIGN_SEND_MAX_ATTEMPTS;
        const retry = f.retryable && n < CAMPAIGN_SEND_MAX_ATTEMPTS;
        await ctx.tx.update(schema.retentionExposures).set({ status: retry ? "queued" : "failed", error: f.error ?? "error", claimedAt: null, nextAttemptAt: retry ? new Date(at.getTime() + Math.max(f.retryAfterMs ?? 0, campaignRetryDelayMs(n))) : null }).where(and(eq(schema.retentionExposures.id, f.id), eq(schema.retentionExposures.status, "sending")));
        if (!retry) total.failed++;
      }
      total.sent += ok.length;
      await refreshCounters(ctx, c.id);
    });
    if (rateLimited || Date.now() - started > budget) {
      const remaining = await run(async (ctx) => (await refreshCounters(ctx, c.id)).pending);
      return { campaignId, status: "progress", ...total, remaining, retryInMs: rateLimited ? 60_000 : 0 };
    }
  }
}

/* ---------- tick ---------- */

/**
 * The tenant's campaign tick (every minute in the worker, on page loads without one): scheduled
 * one-offs whose time has come start when the send window is open; active sequences enrol their
 * new entrants. Returns the campaigns with messages to deliver (the caller runs or queues
 * `processCampaignSend` for each).
 */
export async function campaignTick(run: TenantRunner, tenant: CampaignTenant, opts: { now?: Date } = {}): Promise<{ started: string[]; enrolled: number; delivering: string[] }> {
  const now = opts.now ?? new Date();
  const open = isInSendWindow(now, sendWindowOf(tenant));
  const due = await run(async (ctx) => ctx.tx.select({ id: schema.retentionCampaigns.id, kind: schema.retentionCampaigns.kind, status: schema.retentionCampaigns.status, scheduledAt: schema.retentionCampaigns.scheduledAt }).from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenantId), inArray(schema.retentionCampaigns.status, ["scheduled", "sending", "active"]))));
  const started: string[] = [];
  let enrolled = 0;
  if (open) {
    for (const c of due) {
      if (c.status === "scheduled" && c.scheduledAt && c.scheduledAt.getTime() <= now.getTime()) {
        const r = await run((ctx) => startCampaignSend({ ...ctx, now }, c.id, tenant.settings));
        if (r.started) started.push(c.id);
      } else if (c.status === "active" && c.kind === "sequence") {
        enrolled += (await run((ctx) => enrollSequence({ ...ctx, now }, c.id, tenant.settings))).enrolled;
      }
    }
  }
  // a sending one-off always (it may only need closing); a sequence when it has messages waiting
  const delivering = await run(async (ctx) => (await ctx.tx.execute<{ id: string }>(sql`
    select rc.id from retention_campaigns rc where rc.tenant_id = ${ctx.tenantId}
      and (rc.status = 'sending' or (rc.status = 'active' and exists (select 1 from retention_exposures e where e.campaign_id = rc.id and e.status in ('queued', 'sending'))))
    order by rc.created_at`)).rows.map((r) => r.id));
  return { started, enrolled, delivering };
}

/* ---------- test send ---------- */

/**
 * Test message to internal recipients (members' emails, or phone numbers typed by the author)
 * before approval: rendered with the recipient's name and the code, never recorded as an exposure.
 */
export async function sendCampaignTest(ctx: ServiceContext, campaignId: string, channel: MessagingChannel, recipients: readonly { to: string; firstName: string }[]): Promise<{ sent: number; failed: number }> {
  const c = await loadCampaign(ctx, campaignId);
  if (c.channel === "manual") throw new RetentionCampaignError("manual_channel");
  if (!["draft", "pending_approval", "approved", "scheduled", "paused"].includes(c.status)) throw new RetentionCampaignError("not_editable");
  if (!recipients.length || recipients.length > 10) throw new RetentionCampaignError("no_recipients");
  const now = ctx.now ?? new Date();
  let sent = 0, failed = 0;
  for (const r of recipients) {
    const vars = { first_name: r.firstName, code: c.discountCode ?? "" };
    try {
      await channel.sendMessage({ to: r.to, template: renderMessage(c.message, vars), variables: vars, idempotencyKey: `rc-test:${c.id}:${r.to}:${now.getTime()}`, meta: { purpose: "test", campaignId: c.id } });
      sent++;
    } catch {
      failed++;
    }
  }
  if (sent) await ctx.tx.update(schema.retentionCampaigns).set({ testSentAt: now, testSentBy: ctx.actor.userId }).where(eq(schema.retentionCampaigns.id, c.id));
  return { sent, failed };
}
