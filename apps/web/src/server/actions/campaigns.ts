"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@keel/config";
import { and, eq, recordAudit, schema } from "@keel/db";
import { autoLinkCampaigns, linkCampaignProduct, unlinkCampaignProduct } from "@keel/services";
import { getAdsPlatform } from "@/server/integrations";
import { ForbiddenError, requireAction, requirePage } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();
const statusSchema = z.enum(["active", "paused"]);

/** Pause/resume: platform first (with explicit confirmation on the client), then local status, then audit. */
export async function setCampaignStatus(slug: string, campaignId: string, status: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "pause_campaign", "campaigns");
    const parsedId = uuid.safeParse(campaignId);
    const parsedStatus = statusSchema.safeParse(status);
    if (!parsedId.success || !parsedStatus.success) return fail("invalid_input");
    const campaign = await ctx.run(async (tx) => (await tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.id, parsedId.data))).limit(1))[0]);
    if (!campaign) return fail("not_found");
    if (campaign.platform !== "meta" && campaign.platform !== "google") return fail("invalid_input");
    if (campaign.status === parsedStatus.data) return ok();
    const platform = await getAdsPlatform(ctx, campaign.platform);
    try {
      await platform.setCampaignStatus(campaign.externalId, parsedStatus.data);
    } catch (e) {
      const code = e instanceof Error && "code" in e && (e as { code?: string }).code === "unsupported" ? "ads_read_only" : "ads_platform_error";
      return fail(code, { platform: e instanceof Error ? e.message : String(e) });
    }
    await ctx.run(async (tx) => {
      await tx.update(schema.campaigns).set({ status: parsedStatus.data, syncedAt: new Date() }).where(eq(schema.campaigns.id, campaign.id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: parsedStatus.data === "paused" ? "campaign.paused" : "campaign.resumed", entityType: "campaign", entityId: campaign.id, diff: { status: { from: campaign.status, to: parsedStatus.data } } });
    });
    revalidatePath(`/t/${slug}/campaigns`);
    revalidatePath(`/t/${slug}/campaigns/${campaign.id}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

async function requireCampaignWrite(slug: string) {
  const ctx = await requirePage(slug, "campaigns");
  if (!canWritePage(ctx.role, "campaigns")) throw new ForbiddenError("edit");
  return ctx;
}

export async function linkProduct(slug: string, campaignId: string, productId: string, isPrimary: boolean, source: "manual" | "suggested" = "manual"): Promise<ActionResult> {
  try {
    const ctx = await requireCampaignWrite(slug);
    if (!uuid.safeParse(campaignId).success || !uuid.safeParse(productId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const [campaign] = await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.id, campaignId))).limit(1);
      const [product] = await tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, productId))).limit(1);
      if (!campaign || !product) throw new NotFound();
      await linkCampaignProduct(s, campaignId, productId, isPrimary, source);
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "campaign.product_linked", entityType: "campaign", entityId: campaignId, diff: { productId: { from: null, to: productId }, isPrimary: { from: null, to: isPrimary }, source: { from: null, to: source } } });
    });
    revalidatePath(`/t/${slug}/campaigns`);
    revalidatePath(`/t/${slug}/campaigns/${campaignId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof NotFound) return fail("not_found");
    throw e;
  }
}

export async function unlinkProduct(slug: string, campaignId: string, productId: string): Promise<ActionResult> {
  try {
    const ctx = await requireCampaignWrite(slug);
    if (!uuid.safeParse(campaignId).success || !uuid.safeParse(productId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      await unlinkCampaignProduct(s, campaignId, productId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "campaign.product_unlinked", entityType: "campaign", entityId: campaignId, diff: { productId: { from: productId, to: null } } });
    });
    revalidatePath(`/t/${slug}/campaigns`);
    revalidatePath(`/t/${slug}/campaigns/${campaignId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function autoLink(slug: string): Promise<ActionResult<{ linked: number }>> {
  try {
    const ctx = await requireCampaignWrite(slug);
    const linked = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const n = await autoLinkCampaigns(s);
      if (n > 0) await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "campaign.auto_linked", entityType: "campaign", diff: { linked: { from: 0, to: n } } });
      return n;
    });
    revalidatePath(`/t/${slug}/campaigns`);
    return ok({ linked });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

class NotFound extends Error {}
