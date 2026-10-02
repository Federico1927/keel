"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { TenantExportError, requestTenantExport } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue, runJobInline } from "@/server/jobs";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Full data export of the tenant (#32), owner only: queued as a background job (or run after the
 * response when no worker is deployed); the owner is notified when the archive is ready.
 */
export async function requestDataExportAction(slug: string): Promise<ActionResult<{ exportId: string; queued: boolean }>> {
  try {
    const ctx = await requireAction(slug, "export_tenant_data", "settings");
    const actor = auditActor(ctx);
    const exportId = await ctx.run((tx) => requestTenantExport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { userId: ctx.user.id, audit: { actorType: actor.actorType, impersonatedBy: actor.impersonatedBy } }));
    const job = { tenantId: ctx.tenant.id, exportId };
    const queued = await enqueue("tenant.export", job);
    if (!queued) after(() => runJobInline("tenant.export", job, null));
    revalidatePath(`/t/${slug}/settings/data-export`);
    return ok({ exportId, queued });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof TenantExportError) return fail(e.code);
    throw e;
  }
}
