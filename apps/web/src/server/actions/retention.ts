"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@hullwise/db";
import { RETENTION_CHANNELS } from "@hullwise/core";
import { deleteRetentionCampaign, getMessagingChannelFor, previewRetentionSend, RetentionCampaignError, saveRetentionCampaign, sendRetentionCampaign, type SendPreview, type SendResult } from "@hullwise/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  segmentId: z.string().uuid(),
  channel: z.enum(RETENTION_CHANNELS),
  message: z.string().max(2000).default(""),
  discountCode: z.string().trim().max(40).optional().transform((v) => (v ? v.toUpperCase() : null)),
  costPerMessage: z.coerce.number().min(0).max(1000).default(0),
  attributionDays: z.coerce.number().int().min(1).max(90),
});

function handle(e: unknown) {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof RetentionCampaignError) return fail(e.code);
  throw e;
}

/** Create or update a draft campaign (form action). */
export async function saveRetentionCampaignAction(slug: string, campaignId: string | null, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    const parsed = schema.safeParse({ name: formData.get("name"), segmentId: formData.get("segmentId"), channel: formData.get("channel"), message: formData.get("message") ?? "", discountCode: formData.get("discountCode") ?? undefined, costPerMessage: formData.get("costPerMessage") || 0, attributionDays: formData.get("attributionDays") });
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    const id = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const id = await saveRetentionCampaign(s, { name: d.name, segmentId: d.segmentId, channel: d.channel, message: d.message, discountCode: d.discountCode, costPerMessageMinor: Math.round(d.costPerMessage * 100), attributionDays: d.attributionDays }, campaignId ?? undefined);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: campaignId ? "retention_campaign.updated" : "retention_campaign.created", entityType: "retention_campaign", entityId: id, diff: { name: { from: null, to: d.name }, channel: { from: null, to: d.channel } } });
      return id;
    });
    revalidatePath(`/t/${slug}/segments/campaigns`, "layout");
    return ok({ id });
  } catch (e) {
    return handle(e);
  }
}

export async function deleteRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    await ctx.run(async (tx) => {
      await deleteRetentionCampaign({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, campaignId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "retention_campaign.deleted", entityType: "retention_campaign", entityId: campaignId, diff: {} });
    });
    revalidatePath(`/t/${slug}/segments/campaigns`, "layout");
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function previewRetentionSendAction(slug: string, campaignId: string): Promise<ActionResult<SendPreview>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    return ok(await ctx.run((tx) => previewRetentionSend({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, campaignId)));
  } catch (e) {
    return handle(e);
  }
}

/** Sends after the user confirmed the preview. Messages go through the tenant's messaging channel (mock until a provider is connected). */
export async function sendRetentionCampaignAction(slug: string, campaignId: string): Promise<ActionResult<SendResult>> {
  try {
    const ctx = await requireWrite(slug, "customer_campaigns");
    const result = await ctx.run(async (tx) => {
      const r = await sendRetentionCampaign({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, campaignId, getMessagingChannelFor(ctx.tenant.id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "retention_campaign.sent", entityType: "retention_campaign", entityId: campaignId, diff: { treated: { from: null, to: r.treated }, holdout: { from: null, to: r.holdout }, delivered: { from: null, to: r.delivered } } });
      return r;
    });
    revalidatePath(`/t/${slug}/segments/campaigns`, "layout");
    return ok(result);
  } catch (e) {
    return handle(e);
  }
}
