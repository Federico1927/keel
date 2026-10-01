"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@keel/db";
import { GoogleAdsPlatform, MetaAdsPlatform, ShopifyCommercePlatform, SHOPIFY_WEBHOOK_TOPICS, encryptJson, integrationMode, isValidShopDomain, type ConnectionTest } from "@keel/integrations";
import { getAdsPlatformFor, getCommercePlatformFor, mockCommerceFor, processWebhookEvent, retryFailedWebhooks, runAdsSync, runCatalogSync, runOrdersSync } from "@keel/services";
import { enqueue } from "@/server/jobs";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const PROVIDERS = ["shopify", "meta", "google"] as const;
type Provider = (typeof PROVIDERS)[number];
const providerSchema = z.enum(PROVIDERS);

async function saveConnection(slug: string, provider: Provider, test: ConnectionTest, credentials: unknown, accountId: string, config: Record<string, unknown> = {}): Promise<ActionResult> {
  const ctx = await requireAction(slug, "manage_integrations", "integrations");
  if (!test.ok) return fail("connection_failed", { platform: test.error ?? "" });
  await ctx.run(async (tx) => {
    const values = { status: "connected", mode: "live", externalAccountId: accountId, externalAccountName: test.accountName ?? accountId, credentialsEncrypted: encryptJson(credentials), config: { ...config, scopes: test.scopes ?? [], missingScopes: test.missingScopes ?? [] }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider, ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
    await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.connected", entityType: "integration", entityId: provider, diff: { status: { from: null, to: "connected" }, account: { from: null, to: accountId } } });
  });
  revalidatePath(`/t/${slug}/integrations`);
  return ok();
}

const shopifySchema = z.object({ shop: z.string().trim().toLowerCase(), accessToken: z.string().trim().min(10), apiSecret: z.string().trim().min(8) });
export async function connectShopifyCustomApp(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const parsed = shopifySchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success || !isValidShopDomain(parsed.data.shop)) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const platform = new ShopifyCommercePlatform(parsed.data);
    const test = await platform.testConnection();
    const saved = await saveConnection(slug, "shopify", test, parsed.data, parsed.data.shop, { installedVia: "custom_app" });
    if (!saved.ok) return saved;
    const callback = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/webhooks/shopify`;
    const regs = await platform.registerWebhooks(callback, SHOPIFY_WEBHOOK_TOPICS).catch(() => []);
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    await ctx.run((tx) => tx.update(schema.integrations).set({ config: { installedVia: "custom_app", scopes: test.scopes ?? [], missingScopes: test.missingScopes ?? [], webhooks: regs } }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "shopify"))));
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const metaSchema = z.object({ accessToken: z.string().trim().min(10), adAccountId: z.string().trim().min(3) });
export async function connectMeta(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const parsed = metaSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const test = await new MetaAdsPlatform(parsed.data).testConnection();
    return saveConnection(slug, "meta", test, parsed.data, parsed.data.adAccountId.startsWith("act_") ? parsed.data.adAccountId : `act_${parsed.data.adAccountId}`);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const googleSchema = z.object({ developerToken: z.string().trim().min(5), clientId: z.string().trim().min(5), clientSecret: z.string().trim().min(5), refreshToken: z.string().trim().min(5), customerId: z.string().trim().min(8), loginCustomerId: z.string().trim().optional().nullable() });
export async function connectGoogle(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const parsed = googleSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const creds = { ...parsed.data, loginCustomerId: parsed.data.loginCustomerId || null };
    const test = await new GoogleAdsPlatform(creds).testConnection();
    return saveConnection(slug, "google", test, creds, creds.customerId.replace(/-/g, ""));
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function disconnectIntegration(slug: string, provider: string): Promise<ActionResult> {
  try {
    const p = providerSchema.safeParse(provider);
    if (!p.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    await ctx.run(async (tx) => {
      await tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, mode: "mock", lastError: null, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, p.data)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.disconnected", entityType: "integration", entityId: p.data, diff: { status: { from: "connected", to: "not_connected" } } });
    });
    revalidatePath(`/t/${slug}/integrations`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function testIntegration(slug: string, provider: string): Promise<ActionResult<ConnectionTest>> {
  try {
    const p = providerSchema.safeParse(provider);
    if (!p.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const platform = p.data === "shopify" ? await getCommercePlatformFor(s, ctx.tenant) : await getAdsPlatformFor(s, ctx.tenant, p.data);
      const test = await platform.testConnection().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as ConnectionTest);
      await tx.update(schema.integrations).set(test.ok ? { lastSuccessAt: new Date(), lastError: null, status: "connected", externalAccountName: test.accountName ?? undefined, updatedAt: new Date() } : { lastError: test.error ?? "connection failed", status: "error", updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, p.data)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.tested", entityType: "integration", entityId: p.data, diff: { ok: { from: null, to: test.ok } } });
      return test;
    });
    revalidatePath(`/t/${slug}/integrations`);
    return ok(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Resync: queued when a worker is available, otherwise run inline with a time budget. */
export async function resyncIntegration(slug: string, provider: string): Promise<ActionResult<{ queued: boolean; summary: string }>> {
  try {
    const p = providerSchema.safeParse(provider);
    if (!p.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.resync_requested", entityType: "integration", entityId: p.data }));
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const queued = p.data === "shopify" ? (await enqueue("sync.orders", { tenantId: ctx.tenant.id, kind: "delta" }, { singletonKey: `${ctx.tenant.id}:delta` })) && (await enqueue("sync.catalog", { tenantId: ctx.tenant.id }, { singletonKey: `${ctx.tenant.id}:catalog` })) : await enqueue("sync.ads", { tenantId: ctx.tenant.id, provider: p.data, since, until }, { singletonKey: `${ctx.tenant.id}:${p.data}:${until}` });
    let summary = "queued";
    if (!queued) {
      summary = await ctx.run(async (tx) => {
        const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
        if (p.data === "shopify") {
          const platform = await getCommercePlatformFor(s, ctx.tenant);
          const orders = await runOrdersSync(s, platform, { kind: "delta", country: ctx.tenant.country, budgetMs: 15_000 });
          const catalog = await runCatalogSync(s, platform);
          return orders.error ?? catalog.error ?? `orders:${orders.rowsWritten} products:${catalog.products} inventory:${catalog.inventory} discounts:${catalog.discounts}`;
        }
        const r = await runAdsSync(s, await getAdsPlatformFor(s, ctx.tenant, p.data), { since, until });
        return r.error ?? `campaigns:${r.campaigns} metrics:${r.metrics}`;
      });
    }
    revalidatePath(`/t/${slug}/integrations`);
    revalidatePath(`/t/${slug}/orders`);
    return ok({ queued, summary });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Mock mode only: builds a signed webhook for a fresh simulated order and posts it to our own endpoint. */
export async function simulateWebhook(slug: string, scenario: "order" | "cancel" | "bad_signature" = "order"): Promise<ActionResult<{ status: number; orderName: string | null }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const row = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "shopify"))).limit(1));
    if (integrationMode() === "live" && row[0]?.mode === "live") return fail("live_mode");
    await ctx.run((tx) => getCommercePlatformFor({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.tenant));
    const mock = mockCommerceFor(ctx.tenant.id);
    if (!mock) return fail("unknown");
    const order = mock.generateOrder(new Date());
    if (scenario === "cancel") await mock.cancelOrder(order.externalId, { restock: true, refund: true });
    const env = mock.buildWebhook(scenario === "cancel" ? "orders/cancelled" : "orders/create", (await mock.fetchOrder(order.externalId)) ?? order);
    const headers: Record<string, string> = { ...env.headers, "x-shopify-shop-domain": row[0]?.externalAccountId ?? env.headers["x-shopify-shop-domain"]!, "content-type": "application/json" };
    if (scenario === "bad_signature") headers["x-shopify-hmac-sha256"] = "invalid";
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${base}/api/webhooks/shopify`, { method: "POST", headers, body: env.rawBody });
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.webhook_simulated", entityType: "integration", entityId: "shopify", diff: { scenario: { from: null, to: scenario }, status: { from: null, to: res.status } } }));
    revalidatePath(`/t/${slug}/integrations`);
    revalidatePath(`/t/${slug}/orders`);
    return ok({ status: res.status, orderName: scenario === "bad_signature" ? null : order.name });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function retryWebhooks(slug: string): Promise<ActionResult<{ retried: number; processed: number }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const r = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      return retryFailedWebhooks(s, await getCommercePlatformFor(s, ctx.tenant), { country: ctx.tenant.country, maxAttempts: 10 });
    });
    revalidatePath(`/t/${slug}/integrations`);
    return ok(r);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function processWebhookNow(slug: string, eventId: string): Promise<ActionResult<{ status: string }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    if (!z.string().uuid().safeParse(eventId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      return processWebhookEvent(s, await getCommercePlatformFor(s, ctx.tenant), eventId, { country: ctx.tenant.country });
    });
    revalidatePath(`/t/${slug}/integrations`);
    return ok({ status: r.status });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
