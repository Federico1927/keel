"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { eq, schema, withTenant } from "@hullwise/db";
import { CustomerErasureError, TenantDeletionError, eraseCustomerOnRequest, findCustomersByEmail, requestCustomerExportAsAdmin, requestTenantDeletion, retryTenantDeletion, type CustomerRedactionReport } from "@hullwise/services";
import { requireSuperAdmin } from "@/server/admin";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { enqueue, runJobInline } from "@/server/jobs";

/**
 * Console privacy actions: a customer's erasure or data package for a tenant (the platform owner answering
 * the merchant), and the deletion of a whole tenant. Tenant data is read and written inside the tenant's
 * RLS transaction; every action is audited as the super-admin.
 */
const uuid = z.string().uuid();

export interface ErasureCandidate {
  id: string;
  name: string | null;
  email: string | null;
  ordersCount: number;
  externalId: string | null;
}

export async function findCustomerForErasureAction(tenantId: string, email: string): Promise<ActionResult<ErasureCandidate[]>> {
  const { user } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success || !z.string().trim().email().safeParse(email).success) return fail("invalid_input");
  const rows = await withTenant(tenantId, (tx) => findCustomersByEmail({ tenantId, tx, actor: { type: "user", userId: user.id } }, email));
  return ok(rows.map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || null, email: r.email, ordersCount: r.ordersCount, externalId: r.externalId })));
}

export async function eraseCustomerAsAdminAction(tenantId: string, customerId: string, confirmation: string): Promise<ActionResult<CustomerRedactionReport>> {
  const { user } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success || !uuid.safeParse(customerId).success || typeof confirmation !== "string" || confirmation.length > 320) return fail("invalid_input");
  try {
    const report = await withTenant(tenantId, (tx) => eraseCustomerOnRequest({ tenantId, tx, actor: { type: "user", userId: user.id } }, { customerId, confirmation, audit: { actorType: "super_admin" } }));
    revalidatePath(`/admin/tenants/${tenantId}`);
    return ok(report);
  } catch (e) {
    if (e instanceof CustomerErasureError) return fail(e.code);
    throw e;
  }
}

/** Rebuilds the data package a compliance task points at (e.g. after the link expired); the task is updated with the new export. */
export async function rebuildCustomerExportAction(alertId: string): Promise<ActionResult<{ exportId: string }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(alertId).success) return fail("invalid_input");
  const [alert] = await db.select().from(schema.platformAlerts).where(eq(schema.platformAlerts.id, alertId)).limit(1);
  if (!alert || alert.kind !== "compliance_request" || !alert.tenantId || !alert.subject.includes("customers/data_request")) return fail("not_found");
  const meta = alert.meta as { customerId?: string | null; customer_id?: string | number | null; orders?: (string | number)[] };
  const tenantId = alert.tenantId;
  const exportId = await requestCustomerExportAsAdmin(db, tenantId, { customerId: meta.customerId ?? null, customerExternalId: meta.customer_id == null ? null : String(meta.customer_id), orderExternalIds: Array.isArray(meta.orders) ? meta.orders : [], requestRef: alert.subject }, user.id);
  await db.update(schema.platformAlerts).set({ meta: { ...(alert.meta as Record<string, unknown>), exportId } }).where(eq(schema.platformAlerts.id, alertId));
  const job = { tenantId, exportId };
  if (!(await enqueue("tenant.export", job))) after(() => runJobInline("tenant.export", job, user.id));
  revalidatePath("/admin/alerts");
  return ok({ exportId });
}

const deletionSchema = z.object({ confirmSlug: z.string().trim().min(1).max(80), confirmDemo: z.boolean().optional(), withoutExport: z.boolean().optional(), reason: z.string().trim().max(500).optional() });

/** Deletes a tenant (danger zone): validated and recorded now, executed by the `tenant.delete` job. */
export async function requestTenantDeletionAction(tenantId: string, input: z.input<typeof deletionSchema>): Promise<ActionResult<{ deletionId: string; queued: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  const parsed = deletionSchema.safeParse(input);
  if (!uuid.safeParse(tenantId).success || !parsed.success) return fail("invalid_input");
  try {
    const deletionId = await requestTenantDeletion(db, tenantId, parsed.data, user.id);
    const job = { deletionId };
    const queued = await enqueue("tenant.delete", job);
    if (!queued) after(() => runJobInline("tenant.delete", job, user.id));
    revalidatePath(`/admin/tenants/${tenantId}/delete`);
    revalidatePath("/admin/tenants");
    return ok({ deletionId, queued });
  } catch (e) {
    if (e instanceof TenantDeletionError) return fail(e.code);
    throw e;
  }
}

export async function retryTenantDeletionAction(deletionId: string): Promise<ActionResult<{ queued: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(deletionId).success) return fail("invalid_input");
  if (!(await retryTenantDeletion(db, deletionId, user.id))) return fail("not_found");
  const job = { deletionId };
  const queued = await enqueue("tenant.delete", job);
  if (!queued) after(() => runJobInline("tenant.delete", job, user.id));
  return ok({ queued });
}
