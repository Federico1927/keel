"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MANUAL_LIFECYCLE_REASONS, PLAN_KEYS, TENANT_STATUSES } from "@keel/config";
import { eq, recordAudit, schema } from "@keel/db";
import { AccountError, AdminUserError, BillingError, LifecycleError, revokeUserSessions, setTrialEnd, setUserDisabled, transitionTenant, applySuspensions, createTenant, requestPasswordReset, emailSettings, issueDueInvoices, recordInvoicePayment, removeAddressSuppression, sendTestEmail, setTenantAddon, setTenantPlan, setTenantSuspension, voidInvoice, TenantExportError, closePlatformAlert, requestTenantExportAsAdmin } from "@keel/services";
import { runNowJob } from "@keel/jobs";
import { requireSuperAdmin } from "@/server/admin";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { enqueue, runJobInline } from "@/server/jobs";
import "@/server/email";

const uuid = z.string().uuid();

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(60),
  country: z.string().trim().length(2),
  currency: z.string().trim().length(3),
  timezone: z.string().trim().min(3),
  defaultLocale: z.enum(["en", "it", "es"]),
  orderNumberPrefix: z.string().trim().max(10),
  planKey: z.enum(PLAN_KEYS),
  taxRateBps: z.coerce.number().int().min(0).max(5000),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(1).max(80),
});

export async function createTenantAction(_prev: ActionResult<{ tenantId: string; ownerEmail: string }> | null, formData: FormData): Promise<ActionResult<{ tenantId: string; ownerEmail: string }>> {
  const { user, db } = await requireSuperAdmin();
  const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
  try {
    // the owner receives an invitation (#52): the console never sees or sets a password
    const r = await createTenant(db, parsed.data, user.id);
    revalidatePath("/admin");
    return ok({ tenantId: r.tenantId, ownerEmail: r.ownerEmail });
  } catch (e) {
    if (e instanceof Error && (e.message === "slug_taken" || e.message === "invalid_slug" || e.message === "invalid_owner_email")) return fail(e.message);
    throw e;
  }
}

/**
 * "Send password reset" from the console (#52): the same flow as "Forgot password?", the email goes
 * to the person; the super-admin never sees the link nor sets a password. Audited by the service.
 */
export async function sendPasswordResetAction(userId: string): Promise<ActionResult<{ sent: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(userId).success) return fail("invalid_input");
  const [target] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!target) return fail("not_found");
  try {
    return ok(await requestPasswordReset(db, { email: target.email, requestedBy: user.id }));
  } catch (e) {
    if (e instanceof AccountError) return fail(e.code);
    throw e;
  }
}

export async function setAddonAction(tenantId: string, moduleKey: string, active: boolean, note: string | null): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  try {
    // with a Stripe subscription the items follow (prorated); a refused change leaves Keel untouched
    await setTenantAddon(db, tenantId, moduleKey, active, user.id, note);
  } catch (e) {
    if (e instanceof Error && e.message === "addon_not_available") return fail("addon_not_available");
    if (e instanceof BillingError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin/tenants");
  return ok();
}

export async function setPlanAction(tenantId: string, planKey: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  const p = z.enum(PLAN_KEYS).safeParse(planKey);
  if (!uuid.safeParse(tenantId).success || !p.success) return fail("invalid_input");
  try {
    await setTenantPlan(db, tenantId, p.data, user.id);
  } catch (e) {
    if (e instanceof BillingError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  return ok();
}

export async function setSuspensionAction(tenantId: string, suspend: boolean, note: string | null): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  await setTenantSuspension(db, tenantId, suspend, user.id, note ?? undefined);
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin/tenants");
  return ok();
}

export async function markInvoicePaidAction(invoiceId: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(invoiceId).success) return fail("invalid_input");
  await recordInvoicePayment(db, invoiceId, user.id);
  revalidatePath("/admin/billing");
  revalidatePath("/admin/tenants");
  return ok();
}

export async function voidInvoiceAction(invoiceId: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(invoiceId).success) return fail("invalid_input");
  await voidInvoice(db, invoiceId, user.id);
  revalidatePath("/admin/billing");
  return ok();
}

export async function runBillingAction(): Promise<ActionResult<{ issued: number; suspended: number }>> {
  const { user, db } = await requireSuperAdmin();
  const issued = await issueDueInvoices(db, { actorUserId: user.id });
  const sus = await applySuspensions(db, { actorUserId: user.id });
  await recordAudit(db, { tenantId: null, actorUserId: user.id, actorType: "super_admin", action: "billing.run", metadata: { issued: issued.issued, suspended: sus.suspended } });
  revalidatePath("/admin");
  revalidatePath("/admin/billing");
  revalidatePath("/admin/tenants");
  return ok({ issued: issued.issued, suspended: sus.suspended });
}

/** Support access: audited start of an impersonation session, then straight into the tenant. */
export async function openAsSupportAction(tenantId: string): Promise<never> {
  const { user, db } = await requireSuperAdmin();
  const [tenant] = await db.select({ slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) redirect("/admin/tenants");
  await recordAudit(db, { tenantId, actorUserId: user.id, actorType: "super_admin", action: "impersonation.started", entityType: "tenant", entityId: tenantId });
  redirect(`/t/${tenant.slug}`);
}

/** Console → Email: a platform test email through the same queue as every other email (audited in the service). */
export async function sendTestEmailAction(_prev: ActionResult<{ outcome: string; email: string; mock: boolean }> | null, formData: FormData): Promise<ActionResult<{ outcome: string; email: string; mock: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  const email = z.string().trim().email().max(254).safeParse(formData.get("to"));
  if (!email.success) return fail("invalid_input");
  const r = await sendTestEmail(db, { to: email.data, locale: user.locale ?? null, actorUserId: user.id });
  revalidatePath("/admin/email");
  return ok({ outcome: r.outcome, email: email.data, mock: emailSettings().provider === "mock" });
}

/** Lifts a platform suppression (the mailbox works again). Audited in the service. */
export async function removeAddressSuppressionAction(id: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(id).success) return fail("invalid_input");
  if (!(await removeAddressSuppression(db, id, user.id))) return fail("not_found");
  revalidatePath("/admin/email");
  return ok();
}

/** Leaves support mode (#48): audited, back to the console. */
export async function exitImpersonationAction(slug: string): Promise<never> {
  const { user, db } = await requireSuperAdmin();
  const [tenant] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, String(slug))).limit(1);
  if (tenant) await recordAudit(db, { tenantId: tenant.id, actorUserId: user.id, actorType: "super_admin", action: "impersonation.ended", entityType: "tenant", entityId: tenant.id });
  redirect("/admin");
}

const lifecycleSchema = z.object({ to: z.enum(TENANT_STATUSES), reason: z.enum(MANUAL_LIFECYCLE_REASONS), note: z.string().trim().min(3).max(1000) });

/** Lifecycle change from the console: reason and note are required; `suspended` and `churned` lock the tenant's users out. */
export async function transitionTenantAction(tenantId: string, input: { to: string; reason: string; note: string }): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  const parsed = lifecycleSchema.safeParse(input);
  if (!uuid.safeParse(tenantId).success || !parsed.success) return fail("invalid_input");
  try {
    const r = await transitionTenant(db, tenantId, { ...parsed.data, actorUserId: user.id, manual: parsed.data.to === "suspended" });
    if (!r.changed) return fail("unchanged");
  } catch (e) {
    if (e instanceof LifecycleError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin/tenants");
  revalidatePath("/admin");
  return ok();
}

export async function setTrialEndAction(tenantId: string, date: string, note: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(date);
  if (!uuid.safeParse(tenantId).success || !d.success) return fail("invalid_input");
  try {
    await setTrialEnd(db, tenantId, new Date(`${d.data}T23:59:59Z`), user.id, note || null);
  } catch (e) {
    if (e instanceof LifecycleError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  return ok();
}

/** Platform-wide disable or enable of a person (#48): sessions end, sign-in refused, audited; never a password. */
export async function setUserDisabledAction(userId: string, disabled: boolean, reason: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(userId).success) return fail("invalid_input");
  try {
    await setUserDisabled(db, { userId, disabled: Boolean(disabled), reason: String(reason ?? "").slice(0, 500), actorUserId: user.id });
  } catch (e) {
    if (e instanceof AdminUserError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/users");
  return ok();
}

export async function revokeUserSessionsAction(userId: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(userId).success) return fail("invalid_input");
  try {
    await revokeUserSessions(db, { userId, actorUserId: user.id });
  } catch (e) {
    if (e instanceof AdminUserError) return fail(e.code);
    throw e;
  }
  revalidatePath(`/admin/users/${userId}`);
  return ok();
}

/**
 * "Run now" from the job history (#32): a scheduler tick or a tenant's pull, queued for the worker
 * (or run in this process after the response when no worker is deployed). Audited; the run is
 * recorded with the super-admin as requester.
 */
export async function runJobNowAction(jobType: string, tenantId: string | null): Promise<ActionResult<{ queued: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  if (tenantId !== null && !uuid.safeParse(tenantId).success) return fail("invalid_input");
  if (tenantId) {
    const [t] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    if (!t) return fail("not_found");
  }
  const job = runNowJob(jobType, tenantId);
  if (!job) return fail("not_runnable");
  await recordAudit(db, { tenantId, actorUserId: user.id, actorType: "super_admin", action: "admin.job_run_now", entityType: "job", entityId: jobType, metadata: { queue: job.queue } });
  const data = { ...job.data, requestedBy: user.id };
  const queued = await enqueue(job.queue, data);
  if (!queued) after(() => runJobInline(job.queue, data, user.id));
  revalidatePath("/admin/jobs");
  return ok({ queued });
}

/** Closes a platform failure alert by hand (audited by the service). */
export async function closeAlertAction(alertId: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(alertId).success) return fail("invalid_input");
  if (!(await closePlatformAlert(db, alertId, user.id))) return fail("not_found");
  revalidatePath("/admin/alerts");
  return ok();
}

/** Full data export of a tenant asked from the console (#32): background job, audited on the tenant. */
export async function requestTenantDataExportAction(tenantId: string): Promise<ActionResult<{ exportId: string; queued: boolean }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  const [t] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!t) return fail("not_found");
  try {
    const exportId = await requestTenantExportAsAdmin(db, tenantId, user.id);
    const queued = await enqueue("tenant.export", { tenantId, exportId });
    if (!queued) after(() => runJobInline("tenant.export", { tenantId, exportId }, user.id));
    revalidatePath(`/admin/tenants/${tenantId}`);
    return ok({ exportId, queued });
  } catch (e) {
    if (e instanceof TenantExportError) return fail(e.code);
    throw e;
  }
}
