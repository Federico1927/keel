"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@keel/db";
import { recomputePredictions, type PredictionRunResult } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/** Refits the tenant's model now instead of waiting for the nightly run. Same permission as editing segments. */
export async function recomputePredictionsAction(slug: string): Promise<ActionResult<PredictionRunResult>> {
  try {
    const ctx = await requireWrite(slug, "segments");
    const result = await ctx.run(async (tx) => {
      const r = await recomputePredictions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.settings);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "predictions.recomputed", entityType: "tenant", entityId: ctx.tenant.id, diff: { customers: { from: null, to: r.customers }, status: { from: null, to: r.status } } });
      return r;
    });
    revalidatePath(`/t/${slug}/customers`, "layout");
    return ok(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
