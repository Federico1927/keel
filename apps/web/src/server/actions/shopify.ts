"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema, sql } from "@hullwise/db";
import { SHOPIFY_SETUP, apiEndpoint, validateSetupFields } from "@hullwise/config";
import { SHOPIFY_SCOPES_BY_MODULE, SHOPIFY_WEBHOOK_TOPICS, ShopifyCommercePlatform, ShopifyGrantError, encryptJson, integrationMode, isValidShopDomain, missingShopifyScopes, requestClientCredentialsToken, type ShopifyCredentials } from "@hullwise/integrations";
import { saveShopifyConnection } from "@/server/shopify-connection";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { startHistoryImport, type HistoryImportStart } from "@/server/history-import";

/** What Connect answers on success: the store, the optional scopes still missing, what happened to the history import. */
export interface ShopifyConnected {
  mock: boolean;
  shop: string;
  missingOptional: string[];
  history: HistoryImportStart["action"];
}

/** Mock affordance: a Client ID containing this makes the simulated app version miss the order scopes (tests, demos of the error). */
const MOCK_MISSING_SCOPES_MARKER = "missing-scopes";

const save = (ctx: TenantContext, values: Parameters<typeof saveShopifyConnection>[2]) => saveShopifyConnection(ctx.tenant.id, auditActor(ctx), values);

/** The merchant's app credentials, kept (secret encrypted) so "Install on your store" can run the OAuth fallback with them. */
async function rememberApp(ctx: TenantContext, app: { shop: string; clientId: string; clientSecret: string }): Promise<void> {
  const stored = { shop: app.shop, clientId: app.clientId, secretEncrypted: encryptJson({ clientSecret: app.clientSecret }), savedAt: new Date().toISOString() };
  await ctx.run(async (tx) => {
    const patch = sql`coalesce(${schema.integrations.config}, '{}'::jsonb) || jsonb_build_object('app', ${JSON.stringify(stored)}::jsonb)`;
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "shopify", status: "not_connected", mode: "mock", config: { app: stored } }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { config: patch, updatedAt: new Date() } });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.app_saved", entityType: "integration", entityId: "shopify", diff: { clientId: { from: null, to: app.clientId }, shop: { from: null, to: app.shop } } });
  });
}

/**
 * Main path (issue #89): the merchant's own Dev Dashboard app. Shop domain + Client ID + Client secret →
 * client credentials grant (store in the app's organization) → test (scopes) → save encrypted (token
 * cached with its expiry, renewed by the adapter) → webhooks → history import. When Shopify refuses the
 * grant because the store is outside the app's organization (or the app is not installed yet), the answer
 * is `not_in_organization` / `not_installed` and the card offers "Install on your store" (authorization
 * code grant with the same saved credentials). In mock mode the simulated store connects.
 */
export async function connectShopifyApp(slug: string, _prev: ActionResult<ShopifyConnected> | null, formData: FormData): Promise<ActionResult<ShopifyConnected>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const v = validateSetupFields(SHOPIFY_SETUP, Object.fromEntries(formData.entries()));
    if (!v.ok) return fail("invalid_input", { field: v.field });
    const { shop, clientId, clientSecret } = v.values as { shop: string; clientId: string; clientSecret: string };
    await rememberApp(ctx, { shop, clientId, clientSecret });
    if (integrationMode() !== "live") return connectSimulated(ctx, shop, clientId);
    let token;
    try {
      token = await requestClientCredentialsToken(shop, clientId, clientSecret);
    } catch (e) {
      if (e instanceof ShopifyGrantError) return fail(e.reason === "wrong_credentials" ? "wrong_credentials" : e.reason === "unknown" ? "unknown" : e.reason, { platform: e.message });
      return fail("unknown", { platform: e instanceof Error ? e.message : String(e) });
    }
    // a token without scopes: the app has no released version with scopes on this store
    if (!token.scopes.length) return fail("version_not_released");
    const credentials: ShopifyCredentials = { shop, clientId, apiSecret: clientSecret, accessToken: token.accessToken, expiresAt: token.expiresAt, grant: "client_credentials" };
    const platform = new ShopifyCommercePlatform(credentials);
    const test = await platform.testConnection();
    if (!test.ok) return fail("unknown", { platform: test.error ?? "" });
    if (test.missingRequiredScopes?.length) return fail("missing_scopes", { scopes: test.missingRequiredScopes.join(", ") });
    const regs = await platform.registerWebhooks(apiEndpoint("/webhooks/shopify"), SHOPIFY_WEBHOOK_TOPICS).catch(() => []);
    await save(ctx, { mode: "live", shop, name: test.accountName ?? shop, credentials: platform.credentials as ShopifyCredentials, test, config: { installedVia: "client_credentials", webhooks: regs } });
    const history = await startHistoryImport(ctx.tenant, { actorUserId: ctx.user.id });
    revalidate(slug);
    return ok({ mock: false, shop, missingOptional: test.missingScopes ?? [], history: history.action });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/**
 * Mock mode: the simulated store connects with whatever the form holds (nothing leaves the process). A
 * tenant without any catalog or order gets the deterministic demo store with its order history (#87).
 */
async function connectSimulated(ctx: TenantContext, shop: string, clientId: string): Promise<ActionResult<ShopifyConnected>> {
  if (clientId.includes(MOCK_MISSING_SCOPES_MARKER)) return fail("missing_scopes", { scopes: missingShopifyScopes([...SHOPIFY_SCOPES_BY_MODULE["core.catalog"]!, ...SHOPIFY_SCOPES_BY_MODULE["core.crm"]!]).required.join(", ") });
  const empty = await ctx.run(async (tx) => {
    const [o] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenant.id));
    const [p] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenant.id));
    return (o?.n ?? 0) === 0 && (p?.n ?? 0) === 0;
  });
  const domain = `mock-${ctx.tenant.slug}.myshopify.com`;
  await save(ctx, { mode: "mock", shop: domain, name: `${shop} (simulated)`, credentials: null, test: { ok: true }, config: { installedVia: "mock", ...(empty ? { mockStore: "demo" } : {}) } });
  const history = await startHistoryImport(ctx.tenant, { actorUserId: ctx.user.id });
  revalidate(ctx.tenant.slug);
  return ok({ mock: true, shop: domain, missingOptional: [], history: history.action });
}

const legacySchema = z.object({ shop: z.string().trim().toLowerCase(), accessToken: z.string().trim().min(10), apiSecret: z.string().trim().min(8) });
/**
 * Advanced: an existing custom app created in the Shopify admin before 2026 (pasted `shpat_` token and
 * API secret). Shopify no longer lets anyone create these; kept for stores that already have one.
 */
export async function connectShopifyCustomApp(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const parsed = legacySchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success || !isValidShopDomain(parsed.data.shop)) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const credentials: ShopifyCredentials = { ...parsed.data, grant: "static" };
    const platform = new ShopifyCommercePlatform(credentials);
    const test = await platform.testConnection();
    if (!test.ok) return fail(/401/.test(test.error ?? "") ? "wrong_credentials" : "connection_failed", { platform: test.error ?? "" });
    const regs = await platform.registerWebhooks(apiEndpoint("/webhooks/shopify"), SHOPIFY_WEBHOOK_TOPICS).catch(() => []);
    await save(ctx, { mode: "live", shop: parsed.data.shop, name: test.accountName ?? parsed.data.shop, credentials, test, config: { installedVia: "custom_app", webhooks: regs } });
    await startHistoryImport(ctx.tenant, { actorUserId: ctx.user.id });
    revalidate(slug);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** "Continue import": the next slice of a paused history import (inline without a worker, queued otherwise). */
export async function continueHistoryImport(slug: string): Promise<ActionResult<{ queued: boolean; orders: number | null }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const r = await startHistoryImport(ctx.tenant, { resumeOnly: true, actorUserId: ctx.user.id });
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.history_import_continued", entityType: "integration", entityId: "shopify", metadata: { action: r.action, queued: r.queued } }));
    revalidate(slug);
    if (r.error) return fail("connection_failed", { platform: r.error });
    return ok({ queued: r.queued, orders: r.inlineOrders });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

function revalidate(slug: string) {
  revalidatePath(`/t/${slug}/integrations`);
  revalidatePath(`/t/${slug}`, "layout");
}
