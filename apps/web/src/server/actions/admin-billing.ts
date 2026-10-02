"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PLAN_KEYS } from "@keel/config";
import { BillingError, appBaseUrl, resyncTenantBilling, simulateMockCheckout, simulateMockPayment, simulateMockRenewal, startSubscription, syncBillingCatalog, type CatalogSyncSummary, type StartSubscriptionResult } from "@keel/services";
import { requireSuperAdmin } from "@/server/admin";
import { fail, ok, type ActionResult } from "@/server/action-result";
import "@/server/email";

/**
 * Console billing actions (#53). Each starts with requireSuperAdmin() (enforced by a unit test)
 * and is audited in the service. Provider errors come back as a code, never with the key.
 */
const uuid = z.string().uuid();
const billingFail = (e: unknown) => {
  if (e instanceof BillingError) return fail(e.code);
  throw e;
};
const refresh = (tenantId?: string) => {
  revalidatePath("/admin/billing/subscriptions");
  revalidatePath("/admin/billing");
  if (tenantId) revalidatePath(`/admin/tenants/${tenantId}`);
};

export async function syncCatalogAction(): Promise<ActionResult<CatalogSyncSummary>> {
  const { user, db } = await requireSuperAdmin();
  try {
    const r = await syncBillingCatalog(db, { actorUserId: user.id });
    refresh();
    return ok(r);
  } catch (e) {
    return billingFail(e);
  }
}

const startSchema = z.object({
  planKey: z.enum(PLAN_KEYS),
  addons: z.array(z.string().max(60)).max(20),
  chargeSetupFee: z.boolean(),
  trialDays: z.coerce.number().int().min(0).max(365),
  billingEmail: z.string().trim().email().max(254),
  collection: z.enum(["checkout", "invoice"]),
  paymentTermsDays: z.coerce.number().int().min(1).max(120).optional(),
});

export async function startSubscriptionAction(tenantId: string, input: z.input<typeof startSchema>): Promise<ActionResult<StartSubscriptionResult>> {
  const { user, db } = await requireSuperAdmin();
  const parsed = startSchema.safeParse(input);
  if (!uuid.safeParse(tenantId).success || !parsed.success) return fail("invalid_input");
  try {
    const r = await startSubscription(db, tenantId, parsed.data, { actorUserId: user.id, appUrl: appBaseUrl() });
    refresh(tenantId);
    return ok(r);
  } catch (e) {
    return billingFail(e);
  }
}

export async function resyncBillingAction(tenantId: string): Promise<ActionResult<{ subscription: boolean; invoices: number }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  try {
    const r = await resyncTenantBilling(db, tenantId, { actorUserId: user.id });
    refresh(tenantId);
    return ok(r);
  } catch (e) {
    return billingFail(e);
  }
}

/** Mock mode only: plays Stripe's side (checkout paid, renewal paid or declined, failed invoice paid) through the webhook processing. */
export async function simulateBillingAction(tenantId: string, what: "checkout" | "renewal" | "renewal_failed" | "payment"): Promise<ActionResult<{ processed: number }>> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success || !["checkout", "renewal", "renewal_failed", "payment"].includes(what)) return fail("invalid_input");
  try {
    const r = what === "checkout" ? await simulateMockCheckout(db, tenantId, { actorUserId: user.id }) : what === "payment" ? await simulateMockPayment(db, tenantId, { actorUserId: user.id }) : await simulateMockRenewal(db, tenantId, { actorUserId: user.id, fail: what === "renewal_failed" });
    refresh(tenantId);
    revalidatePath("/admin/tenants");
    return ok(r);
  } catch (e) {
    return billingFail(e);
  }
}
