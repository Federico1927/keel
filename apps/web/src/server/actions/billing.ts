"use server";
import { redirect } from "next/navigation";
import { BillingError, appBaseUrl, createBillingPortalSession } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { getTenantContext } from "@/server/tenant";
import { fail, type ActionResult } from "@/server/action-result";

/** Owner's "Manage payment method" (#53): a Stripe Customer Portal session, then straight there. Owners only. */
export async function openBillingPortalAction(slug: string): Promise<ActionResult> {
  const ctx = await getTenantContext(slug);
  if (ctx.role !== "owner") return fail("forbidden");
  let url: string;
  try {
    const r = await ctx.run((tx) => createBillingPortalSession({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { returnUrl: `${appBaseUrl()}/t/${slug}/settings/billing`, locale: ctx.locale, auditAs: auditActor(ctx) }));
    url = r.url;
  } catch (e) {
    if (e instanceof BillingError) return fail(e.code);
    throw e;
  }
  redirect(url);
}
