"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PLAN_KEYS } from "@keel/config";
import { eq, recordAudit, schema } from "@keel/db";
import { applySuspensions, createTenant, emailSettings, issueDueInvoices, recordInvoicePayment, removeAddressSuppression, sendTestEmail, setTenantAddon, setTenantPlan, setTenantSuspension, voidInvoice } from "@keel/services";
import { requireSuperAdmin } from "@/server/admin";
import { fail, ok, type ActionResult } from "@/server/action-result";
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

export async function createTenantAction(_prev: ActionResult<{ tenantId: string; temporaryPassword: string | null }> | null, formData: FormData): Promise<ActionResult<{ tenantId: string; temporaryPassword: string | null }>> {
  const { user, db } = await requireSuperAdmin();
  const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
  try {
    const r = await createTenant(db, parsed.data, user.id);
    revalidatePath("/admin");
    return ok({ tenantId: r.tenantId, temporaryPassword: r.temporaryPassword });
  } catch (e) {
    if (e instanceof Error && (e.message === "slug_taken" || e.message === "invalid_slug")) return fail(e.message);
    throw e;
  }
}

export async function setAddonAction(tenantId: string, moduleKey: string, active: boolean, note: string | null): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  try {
    await setTenantAddon(db, tenantId, moduleKey, active, user.id, note);
  } catch (e) {
    if (e instanceof Error && e.message === "addon_not_available") return fail("addon_not_available");
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
  await setTenantPlan(db, tenantId, p.data, user.id);
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
