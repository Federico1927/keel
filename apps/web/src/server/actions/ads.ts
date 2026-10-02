"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@keel/db";
import { requestAdStatus, requestNegativeKeyword } from "@keel/services";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();

/** Pause or resume one ad (explicit confirmation on the client): local status, audit and outbox write in one transaction. */
export async function setAdStatusAction(slug: string, adId: string, status: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "pause_campaign", "campaigns");
    const st = z.enum(["active", "paused"]).safeParse(status);
    if (!uuid.safeParse(adId).success || !st.success) return fail("invalid_input");
    const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
    const out = await ctx.run((tx) => requestAdStatus({ ...s, tx }, adId, st.data, auditActor(ctx)));
    if (!out.ok) return fail(out.error);
    if (out.write) await dispatchPlatformWrites(ctx, [out.write]);
    revalidatePath(`/t/${slug}/campaigns`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Exclude a search term as a negative keyword (Google, write scope granted by the tenant), after confirmation. */
export async function addNegativeKeywordAction(slug: string, searchTermId: string, matchType: string, level: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "pause_campaign", "campaigns");
    const m = z.enum(["exact", "phrase", "broad"]).safeParse(matchType);
    const l = z.enum(["campaign", "ad_group"]).safeParse(level);
    if (!uuid.safeParse(searchTermId).success || !m.success || !l.success) return fail("invalid_input");
    const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
    const out = await ctx.run((tx) => requestNegativeKeyword({ ...s, tx }, searchTermId, { matchType: m.data, level: l.data }, auditActor(ctx)));
    if (!out.ok) return fail(out.error);
    if (out.write) await dispatchPlatformWrites(ctx, [out.write]);
    revalidatePath(`/t/${slug}/campaigns`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** The tenant confirms it granted (or revoked) Google Ads write access: ad pause and negative keywords stop being read-only. */
export async function setGoogleWriteAccess(slug: string, enabled: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    await ctx.run(async (tx) => {
      const [row] = await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "google"))).limit(1);
      if (!row) throw new NotFound();
      const before = (row.config as { writeAccess?: boolean }).writeAccess === true;
      if (before === enabled) return;
      await tx.update(schema.integrations).set({ config: { ...(row.config as Record<string, unknown>), writeAccess: enabled }, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.write_access_changed", entityType: "integration", entityId: row.id, diff: { writeAccess: { from: before, to: enabled } } });
    });
    revalidatePath(`/t/${slug}/integrations`);
    revalidatePath(`/t/${slug}/campaigns`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof NotFound) return fail("not_found");
    throw e;
  }
}

class NotFound extends Error {}
