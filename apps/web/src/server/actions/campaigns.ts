"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@hullwise/config";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { autoLinkCampaigns, linkCampaignProduct, requestCampaignStatus, unlinkCampaignProduct } from "@hullwise/services";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction, requirePage } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();
const statusSchema = z.enum(["active", "paused"]);

/**
 * Pause/resume (explicit confirmation on the client): local status, audit and the outbox write in one
 * transaction, then the write runs. Google is read-only in the MVP and a platform outside the plan is
 * refused, both before anything changes.
 */
export async function setCampaignStatus(slug: string, campaignId: string, status: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "pause_campaign", "campaigns");
    const parsedId = uuid.safeParse(campaignId);
    const parsedStatus = statusSchema.safeParse(status);
    if (!parsedId.success || !parsedStatus.success) return fail("invalid_input");
    const out = await ctx.run((tx) => requestCampaignStatus({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, parsedId.data, parsedStatus.data, auditActor(ctx)));
    if (!out.ok) return fail(out.error);
    if (out.write) await dispatchPlatformWrites(ctx, [out.write]);
    revalidatePath(`/t/${slug}/campaigns`);
    revalidatePath(`/t/${slug}/campaigns/${parsedId.data}`);
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
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "campaign.product_linked", entityType: "campaign", entityId: campaignId, diff: { productId: { from: null, to: productId }, isPrimary: { from: null, to: isPrimary }, source: { from: null, to: source } } });
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
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "campaign.product_unlinked", entityType: "campaign", entityId: campaignId, diff: { productId: { from: productId, to: null } } });
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
      if (n > 0) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "campaign.auto_linked", entityType: "campaign", diff: { linked: { from: 0, to: n } } });
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
