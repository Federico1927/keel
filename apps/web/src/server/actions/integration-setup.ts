"use server";
import { revalidatePath } from "next/cache";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { AD_ACCOUNT_LIMIT, INTEGRATION_SETUP, validateSetupFields } from "@hullwise/config";
import { normalizeMetaAccountId } from "@hullwise/core";
import { AnthropicLlmProvider, GoogleAddressProvider, GoogleAdsPlatform, LoopSubscriptionProvider, META_REQUIRED_PERMISSIONS, MetaAdsPlatform, MetaConversionsSink, RechargeSubscriptionProvider, SUBSCRIPTION_PROVIDERS, ShopifySubscriptionProvider, SpokiChannel, IntegrationError, classifySetupError, decryptJson, encryptJson, googleAdsCredentials, integrationMode, simulateSetupCheck, type ConnectionTest, type SetupFailure, type ShopifyCredentials, type StoredGoogleAdsCredentials } from "@hullwise/integrations";
import { AdAccountError, addAdAccount, getAdAccount, getConversionSettings, saveConversionSettings, type ServiceContext } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import { verifySetup, type SetupFacts } from "@/server/integration-verify";
import { pendingGoogleSignInOf } from "@/server/google-signin";
import { spokiWebhookUrl } from "@/server/spoki-webhook";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Merchant self-setup of the integrations (#90): one Connect for every card driven by an
 * `IntegrationSetupGuide` (@hullwise/config). The fields are validated with the guide, the vendor is
 * checked (the simulator in mock mode, where trigger values answer with each mapped error), a failure
 * comes back as the guide's plain-words error (`fail("setup", { setup, platform })`), and a success is
 * saved encrypted, audited, and verified by reading real data through the adapter.
 */
export interface SetupConnected {
  verification: SetupFacts | null;
  mock: boolean;
}

const FIELD_PROVIDERS = ["meta", "anthropic", "address", "spoki", "recharge", "loop", "shopify_subscriptions"] as const;
type FieldProvider = (typeof FIELD_PROVIDERS)[number];
const isFieldProvider = (p: string): p is FieldProvider => (FIELD_PROVIDERS as readonly string[]).includes(p);
const isSubscriptionProvider = (p: string) => (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(p);
const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const days = (n: number) => ({ since: new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10), until: new Date().toISOString().slice(0, 10) });

/** The page each provider belongs to: Spoki to its add-on, the subscription apps to theirs. */
function contextFor(slug: string, provider: string): Promise<TenantContext> {
  if (provider === "spoki") return requireAction(slug, "manage_integrations", "whatsapp_settings");
  if (isSubscriptionProvider(provider)) return requireAction(slug, "manage_integrations", "subscriptions");
  return requireAction(slug, "manage_integrations", "integrations");
}

function setupFail(provider: string, f: SetupFailure): ActionResult<never> {
  return fail("setup", { setup: classifySetupError(provider, f) ?? "unknown", platform: f.message ?? "" });
}
const testFail = (provider: string, t: ConnectionTest, stage?: string) => setupFail(provider, { code: t.errorCode ?? null, message: t.error ?? null, stage: stage ?? null });

function revalidate(slug: string, provider: string) {
  revalidatePath(`/t/${slug}/integrations`);
  if (provider === "meta" || provider === "google" || provider === "tiktok") revalidatePath(`/t/${slug}/campaigns`, "layout");
  if (provider === "spoki") revalidatePath(`/t/${slug}/whatsapp/settings`);
  if (isSubscriptionProvider(provider)) revalidatePath(`/t/${slug}/subscriptions`, "layout");
}

async function integrationRowOf(ctx: TenantContext, provider: string) {
  const [row] = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, provider))).limit(1));
  return row ?? null;
}

/** Writes the connection (the previous config kept except a pending sign-in), audits it with the field diff. One subscription app per store: the others are disconnected. */
async function saveSetupConnection(ctx: TenantContext, provider: string, input: { mode: "live" | "mock"; accountId: string; accountName: string | null; credentials: unknown; config?: Record<string, unknown> }): Promise<void> {
  await ctx.run(async (tx) => {
    const [prev] = await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, provider))).limit(1);
    const { pendingSignIn: _pending, ...kept } = (prev?.config ?? {}) as Record<string, unknown>;
    const values = { status: "connected", mode: input.mode, externalAccountId: input.accountId, externalAccountName: input.accountName, credentialsEncrypted: input.credentials ? encryptJson(input.credentials) : null, config: { ...kept, ...input.config, installedVia: input.mode === "mock" ? "mock" : "setup" }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
    if (isSubscriptionProvider(provider)) {
      for (const other of SUBSCRIPTION_PROVIDERS.filter((x) => x !== provider)) await tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, other)));
    }
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider, ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: provider, diff: { status: { from: prev?.status ?? null, to: "connected" }, mode: { from: prev?.mode ?? null, to: input.mode }, account: { from: prev?.externalAccountId ?? null, to: input.accountId } }, metadata: { via: "setup" } });
  });
}

const metaIds = (raw: string) => [...new Set(raw.split(",").map((x) => normalizeMetaAccountId(x.trim())).filter(Boolean))].slice(0, AD_ACCOUNT_LIMIT);

/** Meta's further accounts (#82) and pixel (Conversions API destination) after the main account is saved. */
async function saveMetaExtras(ctx: TenantContext, ids: string[], names: Record<string, string>, pixelId: string, mode: "live" | "mock"): Promise<void> {
  await ctx.run(async (tx) => {
    const s = svc(ctx, tx);
    for (const id of ids.slice(1)) {
      if (await getAdAccount(s, "meta", { externalId: id })) continue;
      // the further accounts read with the integration's token (assigned to the same system user)
      await addAdAccount(s, "meta", { externalAccountId: id, name: names[id] ?? id, mode, credentialsEncrypted: null }, auditActor(ctx)).catch((e: unknown) => {
        if (!(e instanceof AdAccountError)) throw e;
      });
    }
    if (pixelId) {
      const current = (await getConversionSettings(s)).find((c) => c.provider === "meta")!;
      if (current.destinationId !== pixelId) {
        await saveConversionSettings(s, { ...current, destinationId: pixelId });
        await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "conversions.settings_saved", entityType: "conversion_settings", entityId: "meta", diff: { destinationId: { from: current.destinationId, to: pixelId } } });
      }
    }
  });
}

/** The 90-day first import of a newly connected ad platform, on the worker (it resumes itself in windows). */
async function queueAdsBackfill(ctx: TenantContext, provider: "meta" | "google"): Promise<void> {
  const w = days(90);
  await enqueue("sync.ads", { tenantId: ctx.tenant.id, provider, ...w, kind: "backfill" }, { singletonKey: `${ctx.tenant.id}:${provider}:backfill:${w.until}` });
}

/** Mock mode: the simulated vendor answers (trigger values → the mapped errors), then the simulated account is saved. */
async function connectSimulated(ctx: TenantContext, provider: FieldProvider, values: Record<string, string>): Promise<ActionResult> {
  const prev = await integrationRowOf(ctx, provider);
  if (integrationMode() === "live" && prev?.mode === "live" && prev.status !== "not_connected") return fail("live_mode");
  if (provider === "shopify_subscriptions") {
    const shop = await integrationRowOf(ctx, "shopify");
    if (!shop || shop.status === "not_connected") return setupFail(provider, { code: "shopify_not_connected" });
  }
  const failure = simulateSetupCheck(provider, values);
  if (failure) return setupFail(provider, { code: failure.errorCode, message: failure.error, stage: failure.stage ?? null });
  // a simulated account already connected keeps its id (campaign rows and the further accounts point at it)
  const keep = prev && prev.mode === "mock" && prev.status !== "not_connected" && prev.externalAccountId ? { id: prev.externalAccountId, name: prev.externalAccountName } : null;
  if (provider === "meta") {
    const ids = metaIds(values.adAccountIds!);
    const primary = keep?.id ?? ids[0]!;
    await saveSetupConnection(ctx, provider, { mode: "mock", accountId: primary, accountName: keep?.name ?? `${ctx.tenant.name} (Meta demo)`, credentials: null });
    // the first id typed is the main account (a simulated one already connected keeps its id); the others become further accounts
    await saveMetaExtras(ctx, [primary, ...ids.slice(1).filter((id) => id !== primary)], {}, values.pixelId ?? "", "mock");
    return ok();
  }
  const NAMES: Record<Exclude<FieldProvider, "meta">, [string, string]> = { anthropic: ["anthropic-mock", "Mock model"], address: ["address-mock", "Simulated address provider"], spoki: ["spoki-mock", "Simulated Spoki account"], recharge: ["recharge-mock", `${ctx.tenant.name} (simulated Recharge)`], loop: ["loop-mock", `${ctx.tenant.name} (simulated Loop)`], shopify_subscriptions: ["shopify-subscriptions-mock", `${ctx.tenant.name} (simulated Shopify Subscriptions)`] };
  const [id, name] = NAMES[provider];
  await saveSetupConnection(ctx, provider, { mode: "mock", accountId: keep?.id ?? id, accountName: keep?.name ?? name, credentials: null, config: provider === "spoki" ? { webhookUrl: spokiWebhookUrl(ctx.tenant.id) } : {} });
  return ok();
}

/** Live: the vendor is called with the merchant's values; a refusal becomes the guide's plain-words error. */
async function connectLive(ctx: TenantContext, provider: FieldProvider, values: Record<string, string>): Promise<ActionResult> {
  switch (provider) {
    case "meta": {
      const ids = metaIds(values.adAccountIds!);
      const names: Record<string, string> = {};
      let first: ConnectionTest | null = null;
      for (const id of ids) {
        const t = await new MetaAdsPlatform({ accessToken: values.accessToken!, adAccountId: id }).testConnection();
        if (!t.ok) return testFail("meta", t, "account");
        names[id] = t.accountName || id;
        first ??= t;
      }
      const missing = (first?.missingScopes ?? []).filter((p) => p === "ads_read" || p === "ads_management");
      if (missing.length) return setupFail("meta", { code: "missing_permission", message: `Missing permissions: ${missing.join(", ")} (needed: ${META_REQUIRED_PERMISSIONS.join(", ")})` });
      if (values.pixelId) {
        const t = await new MetaConversionsSink({ accessToken: values.accessToken!, adAccountId: ids[0]! }, values.pixelId).testConnection();
        if (!t.ok) return testFail("meta", t, "pixel");
      }
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: ids[0]!, accountName: names[ids[0]!] ?? ids[0]!, credentials: { accessToken: values.accessToken, adAccountId: ids[0] }, config: { scopes: first?.scopes ?? [], missingScopes: first?.missingScopes ?? [] } });
      await saveMetaExtras(ctx, ids, names, values.pixelId ?? "", "live");
      await queueAdsBackfill(ctx, "meta");
      return ok();
    }
    case "anthropic": {
      const t = await new AnthropicLlmProvider({ apiKey: values.apiKey! }).testConnection();
      if (!t.ok) return testFail(provider, t);
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: t.accountId ?? "anthropic", accountName: t.accountName ?? null, credentials: { apiKey: values.apiKey } });
      return ok();
    }
    case "address": {
      const p = new GoogleAddressProvider({ apiKey: values.apiKey! });
      const t = await p.testConnection();
      if (!t.ok) return testFail(provider, t);
      // the second API (Places API (New), the suggestions) is checked too: one autocomplete request
      const places = await p.autocomplete("1600 Amphitheatre Parkway", { country: "US", limit: 1 }).then(() => null, (e: unknown) => e);
      if (places) return setupFail(provider, { code: places instanceof IntegrationError ? places.code : null, message: places instanceof Error ? places.message : String(places) });
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: "google-address", accountName: t.accountName ?? null, credentials: { apiKey: values.apiKey }, config: { vendor: "google" } });
      return ok();
    }
    case "spoki": {
      const t = await new SpokiChannel({ apiKey: values.apiKey! }).testConnection();
      if (!t.ok) return testFail(provider, t);
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: "spoki", accountName: t.accountName ?? "Spoki", credentials: { apiKey: values.apiKey }, config: { webhookUrl: spokiWebhookUrl(ctx.tenant.id) } });
      return ok();
    }
    case "recharge":
    case "loop": {
      const creds = { apiToken: values.apiToken!, webhookSecret: values.webhookSecret! };
      const t = await (provider === "recharge" ? new RechargeSubscriptionProvider(creds) : new LoopSubscriptionProvider(creds)).testConnection();
      if (!t.ok) return testFail(provider, t);
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: t.accountId ?? provider, accountName: t.accountName ?? null, credentials: creds });
      return ok();
    }
    case "shopify_subscriptions": {
      const shop = await integrationRowOf(ctx, "shopify");
      if (!shop || shop.status === "not_connected" || !shop.credentialsEncrypted) return setupFail(provider, { code: "shopify_not_connected" });
      const t = await new ShopifySubscriptionProvider(decryptJson<ShopifyCredentials>(shop.credentialsEncrypted)).testConnection();
      if (!t.ok) return testFail(provider, t);
      // the contracts are read with the Shopify connection's credentials; the marker only makes the row live
      await saveSetupConnection(ctx, provider, { mode: "live", accountId: t.accountId ?? shop.externalAccountId ?? "shopify", accountName: t.accountName ?? null, credentials: { via: "shopify" } });
      return ok();
    }
  }
}

/** Connect of a field-based setup card (Meta, Anthropic, address validation, Spoki, the subscription apps). */
export async function connectSetup(slug: string, provider: string, _prev: ActionResult<SetupConnected> | null, formData: FormData): Promise<ActionResult<SetupConnected>> {
  try {
    if (!isFieldProvider(provider)) return fail("invalid_input");
    const ctx = await contextFor(slug, provider);
    const v = validateSetupFields(INTEGRATION_SETUP[provider]!, Object.fromEntries(formData.entries()));
    if (!v.ok) return fail("setup", { setup: "invalid_input", field: v.field });
    const live = integrationMode() === "live";
    const r = live ? await connectLive(ctx, provider, v.values) : await connectSimulated(ctx, provider, v.values);
    if (!r.ok) return r;
    const verification = await ctx.run((tx) => verifySetup(provider, svc(ctx, tx), ctx.tenant));
    revalidate(slug, provider);
    return ok({ verification, mock: !live });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(e.message === "module_disabled" ? "module_disabled" : "forbidden");
    throw e;
  }
}

/* ---------- Google Ads: "Sign in with Google", then the account pick ---------- */

/** Picks the Google Ads account after the sign-in: checked with a one-row query, saved, imported, verified. */
export async function pickGoogleAdsAccount(slug: string, customerId: string): Promise<ActionResult<SetupConnected>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const row = await integrationRowOf(ctx, "google");
    const pending = pendingGoogleSignInOf(row?.config);
    if (!pending) return fail("setup", { setup: "token_revoked" });
    const account = pending.accounts.find((a) => a.customerId === customerId);
    if (!account) return fail("invalid_input");
    const live = integrationMode() === "live" && !!pending.tokenEncrypted;
    if (live) {
      const stored: StoredGoogleAdsCredentials = { refreshToken: decryptJson<{ refreshToken: string }>(pending.tokenEncrypted!).refreshToken, customerId: account.customerId, loginCustomerId: account.loginCustomerId, app: "platform" };
      let creds;
      try {
        creds = googleAdsCredentials(stored);
      } catch {
        return setupFail("google", { code: "app_not_configured" });
      }
      const t = await new GoogleAdsPlatform(creds).testConnection();
      if (!t.ok) return testFail("google", t);
      await saveSetupConnection(ctx, "google", { mode: "live", accountId: account.customerId, accountName: t.accountName || account.name, credentials: stored, config: { loginCustomerId: account.loginCustomerId, managerName: account.managerName } });
      await queueAdsBackfill(ctx, "google");
    } else {
      const failure = simulateSetupCheck("google", { customerId: account.customerId });
      if (failure) return setupFail("google", { code: failure.errorCode, message: failure.error });
      await saveSetupConnection(ctx, "google", { mode: "mock", accountId: account.customerId, accountName: account.name, credentials: null, config: { loginCustomerId: account.loginCustomerId, managerName: account.managerName } });
    }
    const verification = await ctx.run((tx) => verifySetup("google", svc(ctx, tx), ctx.tenant));
    revalidate(slug, "google");
    return ok({ verification, mock: !live });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
