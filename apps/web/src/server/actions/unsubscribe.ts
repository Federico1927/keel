"use server";
import { withTenant } from "@hullwise/db";
import { addEmailSuppression, applyUnsubscribeToPreferences, verifyUnsubscribeToken } from "@hullwise/services";

/**
 * Public unsubscribe (no session): the signed token names tenant, address and category. The
 * address goes on the tenant's suppression list (audited as a system action) and, for a member,
 * the matching email preference is switched off so the two never disagree.
 */
export async function applyUnsubscribe(token: string): Promise<boolean> {
  const p = verifyUnsubscribeToken(token);
  if (!p) return false;
  await withTenant(p.tenantId, async (tx) => {
    const ctx = { tenantId: p.tenantId, tx, actor: { type: "system" as const, userId: null } };
    await addEmailSuppression(ctx, { email: p.email, reason: "unsubscribe", category: p.category, source: "link" });
    await applyUnsubscribeToPreferences(ctx, p.email, p.category);
  });
  return true;
}

export async function unsubscribeAction(token: string, _prev: { done: boolean } | null): Promise<{ done: boolean }> {
  return { done: await applyUnsubscribe(token) };
}
