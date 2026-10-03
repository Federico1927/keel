import { and, eq, recordAudit, schema, sql, withTenant } from "@hullwise/db";
import { encryptJson, type ConnectionTest, type ShopifyCredentials } from "@hullwise/integrations";
import { forgetCommercePlatform } from "@hullwise/services";

export interface AuditWho {
  actorUserId: string | null;
  actorType: "user" | "impersonation" | "system";
  impersonatedBy?: string | null;
}

/**
 * Writes the Shopify connection of a tenant (every connect path: client credentials, OAuth, legacy token,
 * mock), keeping what a reconnect must not lose (`historyImport` progress, the saved app credentials),
 * audits it and drops the cached adapter so the next call uses the new credentials.
 */
export async function saveShopifyConnection(tenantId: string, who: AuditWho, values: { mode: "live" | "mock"; shop: string; name: string; credentials: ShopifyCredentials | null; test: ConnectionTest; config: Record<string, unknown> }): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [prev] = await tx.select({ status: schema.integrations.status, config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.provider, "shopify"))).limit(1);
    const keep = (prev?.config ?? {}) as Record<string, unknown>;
    const config = { ...(keep.historyImport ? { historyImport: keep.historyImport } : {}), ...(keep.app ? { app: keep.app } : {}), ...values.config, scopes: values.test.scopes ?? [], missingScopes: values.test.missingScopes ?? [], missingRequiredScopes: values.test.missingRequiredScopes ?? [], missingScopesByModule: values.test.missingScopesByModule ?? {} };
    const row = { status: "connected", mode: values.mode, externalAccountId: values.shop, externalAccountName: values.name, credentialsEncrypted: values.credentials ? encryptJson(values.credentials) : null, config, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
    await tx.insert(schema.integrations).values({ tenantId, provider: "shopify", ...row }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: row });
    await recordAudit(tx, { tenantId, actorUserId: who.actorUserId, actorType: who.actorType, impersonatedBy: who.impersonatedBy ?? null, action: "integration.connected", entityType: "integration", entityId: "shopify", diff: { status: { from: prev?.status ?? null, to: "connected" }, shop: { from: null, to: values.shop }, mode: { from: null, to: values.mode } }, metadata: { installedVia: values.config.installedVia ?? null } });
  });
  forgetCommercePlatform(tenantId);
}

/**
 * Records the webhook subscriptions after the connection is saved: Shopify starts delivering as soon as a
 * subscription exists, and a delivery for a shop not saved yet is refused as "unknown shop".
 */
export async function recordShopifyWebhooks(tenantId: string, webhooks: unknown[]): Promise<void> {
  await withTenant(tenantId, (tx) => tx.update(schema.integrations).set({ config: sql`${schema.integrations.config} || ${JSON.stringify({ webhooks })}::jsonb`, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.provider, "shopify"))));
}

/** The tenant's saved app (Client ID, shop, encrypted secret), for the OAuth fallback. */
export interface SavedShopifyApp {
  shop: string;
  clientId: string;
  secretEncrypted: string;
  savedAt?: string;
}
export function savedShopifyApp(config: unknown): SavedShopifyApp | null {
  const app = (config as { app?: Partial<SavedShopifyApp> } | null)?.app;
  return app?.shop && app.clientId && app.secretEncrypted ? (app as SavedShopifyApp) : null;
}
