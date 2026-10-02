"use server";
import { auditActor } from "@/server/audit-actor";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, inArray, recordAudit, schema } from "@hullwise/db";
import { RETENTION_CAMPAIGN_KINDS, RETENTION_CHANNELS, diffRecords, normalizePhone, tenantSettingsSchema, zonedWallTime } from "@hullwise/core";
import { activateSequence, approveRetentionCampaign, deleteRetentionCampaign, getMessagingChannelFor, pauseSequence, previewRetentionSend, recordManualCampaign, rejectRetentionCampaign, reopenRetentionCampaign, RetentionCampaignError, saveRetentionCampaign, scheduleRetentionCampaign, sendCampaignTest, submitRetentionCampaign, unscheduleRetentionCampaign, type CampaignTransition, type SendPreview, type ServiceContext } from "@hullwise/services";
import type { Transaction } from "@hullwise/db";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { kickCampaigns } from "@/server/campaigns";

const schemaInput = z.object({
  name: z.string().trim().min(1).max(120),
  segmentId: z.string().uuid(),
  channel: z.enum(RETENTION_CHANNELS),
  kind: z.enum(RETENTION_CAMPAIGN_KINDS).default("one_off"),
  message: z.string().max(2000).default(""),
  discountCode: z.string().trim().max(40).optional().transform((v) => (v ? v.toUpperCase() : null)),
  costPerMessage: z.coerce.number().min(0).max(1000).default(0),
  attributionDays: z.coerce.number().int().min(1).max(90),
  excludeOpenOrders: z.boolean().default(true),
});
const uuid = z.string().uuid();

const svc = (ctx: TenantContext, tx: Transaction): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

function handle(e: unknown) {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof RetentionCampaignError) return fail(e.code);
  throw e;
}

const revalidate = (slug: string) => revalidatePath(`/t/${slug}/segments/campaigns`, "layout");

/** Create or update a draft campaign (form action). */
export async function saveRetentionCampaignAction(slug: string, campaignId: string | null, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    const parsed = schemaInput.safeParse({ name: formData.get("name"), segmentId: formData.get("segmentId"), channel: formData.get("channel"), kind: formData.get("kind") ?? undefined, message: formData.get("message") ?? "", discountCode: formData.get("discountCode") ?? undefined, costPerMessage: formData.get("costPerMessage") || 0, attributionDays: formData.get("attributionDays"), excludeOpenOrders: formData.get("excludeOpenOrders") === "on" });
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    const id = await ctx.run(async (tx) => {
      const id = await saveRetentionCampaign(svc(ctx, tx), { name: d.name, segmentId: d.segmentId, channel: d.channel, kind: d.kind, message: d.message, discountCode: d.discountCode, costPerMessageMinor: Math.round(d.costPerMessage * 100), attributionDays: d.attributionDays, excludeOpenOrders: d.excludeOpenOrders }, campaignId ?? undefined);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: campaignId ? "retention_campaign.updated" : "retention_campaign.created", entityType: "retention_campaign", entityId: id, diff: { name: { from: null, to: d.name }, channel: { from: null, to: d.channel }, kind: { from: null, to: d.kind } } });
      return id;
    });
    revalidate(slug);
    return ok({ id });
  } catch (e) {
    return handle(e);
  }
}

export async function deleteRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    if (!uuid.safeParse(campaignId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await deleteRetentionCampaign(svc(ctx, tx), campaignId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "retention_campaign.deleted", entityType: "retention_campaign", entityId: campaignId, diff: {} });
    });
    revalidate(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Groups, exclusions by reason and the detectable effect, as the send would see them now. */
export async function previewRetentionSendAction(slug: string, campaignId: string): Promise<ActionResult<SendPreview>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    if (!uuid.safeParse(campaignId).success) return fail("invalid_input");
    return ok(await ctx.run((tx) => previewRetentionSend(svc(ctx, tx), campaignId, ctx.settings)));
  } catch (e) {
    return handle(e);
  }
}

/** One workflow step, audited with the status change and what the step adds. */
async function step(slug: string, campaignId: string, action: string, fn: (s: ServiceContext, ctx: TenantContext) => Promise<CampaignTransition>, opts: { approve?: boolean; metadata?: Record<string, unknown>; kick?: boolean } = {}): Promise<ActionResult> {
  try {
    const ctx = opts.approve ? await requireAction(slug, "approve_customer_campaign", "customer_campaigns") : await requireWrite(slug, "customer_campaigns");
    if (!uuid.safeParse(campaignId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const r = await fn(svc(ctx, tx), ctx);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: `retention_campaign.${action}`, entityType: "retention_campaign", entityId: campaignId, diff: { status: { from: r.from, to: r.to } }, metadata: opts.metadata ?? {} });
    });
    if (opts.kick) after(() => kickCampaigns(ctx));
    revalidate(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function submitRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult> {
  return step(slug, campaignId, "submitted", (s) => submitRetentionCampaign(s, campaignId));
}

export async function approveRetentionCampaignAction(slug: string, campaignId: string, note: string): Promise<ActionResult> {
  const clean = note.trim().slice(0, 500) || null;
  return step(slug, campaignId, "approved", (s, ctx) => approveRetentionCampaign(s, campaignId, { role: ctx.role, note: clean }), { approve: true, metadata: clean ? { note: clean } : {} });
}

export async function rejectRetentionCampaignAction(slug: string, campaignId: string, note: string): Promise<ActionResult> {
  const clean = note.trim().slice(0, 500);
  if (!clean) return fail("note_required");
  return step(slug, campaignId, "rejected", (s, ctx) => rejectRetentionCampaign(s, campaignId, { role: ctx.role, note: clean }), { approve: true, metadata: { note: clean } });
}

export async function reopenRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult> {
  return step(slug, campaignId, "reopened", (s) => reopenRetentionCampaign(s, campaignId));
}

/**
 * Schedules an approved campaign: `local` is a wall-clock time (`YYYY-MM-DDTHH:mm`) in the store's
 * time zone, empty for "as soon as the send window allows".
 */
export async function scheduleRetentionCampaignAction(slug: string, campaignId: string, local: string): Promise<ActionResult> {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (local.trim() && !m) return fail("invalid_input");
  return step(slug, campaignId, "scheduled", async (s, ctx) => scheduleRetentionCampaign(s, campaignId, m ? zonedWallTime(m[1]!, Number(m[2]), Number(m[3]), ctx.tenant.timezone) : null), { kick: true, metadata: { at: local || "asap" } });
}

export async function unscheduleRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult> {
  return step(slug, campaignId, "unscheduled", (s) => unscheduleRetentionCampaign(s, campaignId));
}

export async function activateSequenceAction(slug: string, campaignId: string): Promise<ActionResult> {
  return step(slug, campaignId, "activated", (s) => activateSequence(s, campaignId), { kick: true });
}

export async function pauseSequenceAction(slug: string, campaignId: string): Promise<ActionResult> {
  return step(slug, campaignId, "paused", (s) => pauseSequence(s, campaignId));
}

/** A campaign sent from another tool: its groups are recorded now (no message, no approval). */
export async function recordManualCampaignAction(slug: string, campaignId: string): Promise<ActionResult<{ treated: number; holdout: number }>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    if (!uuid.safeParse(campaignId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const r = await recordManualCampaign(svc(ctx, tx), campaignId, ctx.settings);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "retention_campaign.recorded", entityType: "retention_campaign", entityId: campaignId, diff: { status: { from: "draft", to: "sent" } }, metadata: r });
      return r;
    });
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

/**
 * Test message to internal users: members of the store chosen by id (email channel) or phone
 * numbers typed by the author (SMS, WhatsApp). Through the tenant's messaging channel (mock until a
 * provider is connected).
 */
export async function sendCampaignTestAction(slug: string, campaignId: string, input: { userIds: string[]; phones: string[] }): Promise<ActionResult<{ sent: number }>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    const parsed = z.object({ userIds: z.array(uuid).max(10), phones: z.array(z.string().trim().max(30)).max(5) }).safeParse(input);
    if (!uuid.safeParse(campaignId).success || !parsed.success) return fail("invalid_input");
    const members = parsed.data.userIds.length ? await adminDb().select({ email: schema.users.email, name: schema.users.name, preferred: schema.users.preferredName }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true), inArray(schema.tenantMemberships.userId, parsed.data.userIds))) : [];
    const phones = parsed.data.phones.map((p) => normalizePhone(p, ctx.tenant.country)).filter((p): p is string => Boolean(p));
    const r = await ctx.run(async (tx) => {
      const c = await tx.select({ channel: schema.retentionCampaigns.channel }).from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, ctx.tenant.id), eq(schema.retentionCampaigns.id, campaignId))).limit(1);
      const email = c[0]?.channel === "email";
      const recipients = email ? members.map((m) => ({ to: m.email, firstName: (m.preferred ?? m.name ?? "").split(" ")[0] ?? "" })) : phones.map((p) => ({ to: p, firstName: (ctx.user.name ?? "").split(" ")[0] ?? "" }));
      const r = await sendCampaignTest(svc(ctx, tx), campaignId, getMessagingChannelFor(ctx.tenant.id), recipients);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "retention_campaign.test_sent", entityType: "retention_campaign", entityId: campaignId, diff: {}, metadata: { recipients: recipients.length, sent: r.sent } });
      return r;
    });
    revalidate(slug);
    return ok({ sent: r.sent });
  } catch (e) {
    return handle(e);
  }
}

/* ---------- campaign settings (frequency cap, send window, throttle, measurement lock) ---------- */

const settingsInput = z.object({
  campaignFrequencyCap: z.coerce.number().int().min(1).max(100),
  campaignFrequencyDays: z.coerce.number().int().min(1).max(365),
  campaignSendStartHour: z.coerce.number().int().min(0).max(23),
  campaignSendEndHour: z.coerce.number().int().min(1).max(24),
  throttleEmail: z.coerce.number().int().min(1).max(100_000),
  throttleSms: z.coerce.number().int().min(1).max(100_000),
  throttleWhatsapp: z.coerce.number().int().min(1).max(100_000),
});

export async function saveCampaignSettingsAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "customer_campaigns");
    const parsed = settingsInput.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    if (d.campaignSendStartHour === d.campaignSendEndHour) return fail("invalid_input", { campaignSendEndHour: "same_hour" });
    const current = ctx.settings;
    const next = tenantSettingsSchema.parse({ ...current, campaignFrequencyCap: d.campaignFrequencyCap, campaignFrequencyDays: d.campaignFrequencyDays, campaignSendStartHour: d.campaignSendStartHour, campaignSendEndHour: d.campaignSendEndHour, campaignThrottlePerMinute: { email: d.throttleEmail, sms: d.throttleSms, whatsapp: d.throttleWhatsapp }, campaignMeasurementLock: formData.get("campaignMeasurementLock") === "on" });
    const diff = diffRecords(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    await adminDb().update(schema.tenants).set({ settings: next }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.campaigns_updated", entityType: "tenant", entityId: ctx.tenant.id, diff }));
    revalidate(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}
