import { recordAudit, schema, sql } from "@hullwise/db";
import type { GoogleAdsAccountOption } from "@hullwise/integrations";
import { auditActor } from "@/server/audit-actor";
import type { TenantContext } from "@/server/tenant";

/**
 * "Sign in with Google" for Google Ads (#90): what the sign-in leaves on the integration row until the
 * merchant picks an account (the accounts offered and the encrypted refresh token; nothing for the
 * simulated sign-in). Read by the card's picker and by `pickGoogleAdsAccount`; expires after 30 minutes.
 */
export interface PendingGoogleSignIn {
  accounts: GoogleAdsAccountOption[];
  tokenEncrypted: string | null;
  at: string;
}
const PENDING_TTL_MS = 30 * 60_000;

export function pendingGoogleSignInOf(config: unknown, now = Date.now()): PendingGoogleSignIn | null {
  const p = (config as { pendingSignIn?: PendingGoogleSignIn } | null)?.pendingSignIn;
  return p && Array.isArray(p.accounts) && now - new Date(p.at).getTime() < PENDING_TTL_MS ? p : null;
}

export async function savePendingGoogleSignIn(ctx: TenantContext, pending: PendingGoogleSignIn): Promise<void> {
  await ctx.run(async (tx) => {
    const patch = sql`coalesce(${schema.integrations.config}, '{}'::jsonb) || jsonb_build_object('pendingSignIn', ${JSON.stringify(pending)}::jsonb)`;
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "google", status: "not_connected", mode: "mock", config: { pendingSignIn: pending } }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { config: patch, updatedAt: new Date() } });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.signed_in", entityType: "integration", entityId: "google", diff: { accounts: { from: null, to: pending.accounts.length } } });
  });
}
