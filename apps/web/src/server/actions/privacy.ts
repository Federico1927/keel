"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { CustomerErasureError, eraseCustomerOnRequest, requestCustomerExport, type CustomerRedactionReport } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue, runJobInline } from "@/server/jobs";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Privacy requests from the customer page: the customer's data package (owner, like the full export) and
 * the erasure of their personal data after a typed confirmation (owner and admin). An impersonating
 * super-admin acts as owner and is audited as such.
 */
const uuid = z.string().uuid();

export async function requestCustomerDataExportAction(slug: string, customerId: string): Promise<ActionResult<{ exportId: string; queued: boolean }>> {
  try {
    if (!uuid.safeParse(customerId).success) return fail("invalid_input");
    const ctx = await requireAction(slug, "export_tenant_data", "customers");
    const actor = auditActor(ctx);
    const exportId = await ctx.run((tx) => requestCustomerExport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { userId: ctx.user.id, customerId, audit: { actorType: actor.actorType, impersonatedBy: actor.impersonatedBy } }));
    const job = { tenantId: ctx.tenant.id, exportId };
    const queued = await enqueue("tenant.export", job);
    if (!queued) after(() => runJobInline("tenant.export", job, null));
    revalidatePath(`/t/${slug}/customers/${customerId}`);
    return ok({ exportId, queued });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function eraseCustomerAction(slug: string, customerId: string, confirmation: string): Promise<ActionResult<CustomerRedactionReport>> {
  try {
    if (!uuid.safeParse(customerId).success || typeof confirmation !== "string" || confirmation.length > 320) return fail("invalid_input");
    const ctx = await requireAction(slug, "erase_customer", "customers");
    const actor = auditActor(ctx);
    const report = await ctx.run((tx) => eraseCustomerOnRequest({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { customerId, confirmation, audit: { actorType: actor.actorType, impersonatedBy: actor.impersonatedBy } }));
    revalidatePath(`/t/${slug}/customers/${customerId}`);
    return ok(report);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof CustomerErasureError) return fail(e.code);
    throw e;
  }
}
