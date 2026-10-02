"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, desc, eq, recordAudit, schema } from "@hullwise/db";
import { isAnalyticsPlatformInPlan } from "@hullwise/config";
import { Ga4AnalyticsPlatform, IntegrationError, MockAnalyticsPlatform, encryptJson, ga4ServiceAccountEmail, ga4SetupError, integrationMode, mockGa4Properties, normalizeGa4PropertyId, parseGa4ServiceAccount, platformGa4ServiceAccount, type AnalyticsProperty, type ConnectionTest, type Ga4Credentials, type Ga4SetupError } from "@hullwise/integrations";
import { getAnalyticsPlatformFor, runTrafficSync, type ServiceContext, type TrafficSyncKind } from "@hullwise/services";
import { enqueue } from "@/server/jobs";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * GA4 integration card (#86): connect (service account preferred, OAuth as the alternative), the
 * simulated property in mock mode, property picker, test, resync, disconnect. Every action needs
 * `manage_integrations` and a plan that includes GA4 (`isAnalyticsPlatformInPlan`), and is audited.
 */

async function ga4Context(slug: string): Promise<TenantContext> {
  const ctx = await requireAction(slug, "manage_integrations", "integrations");
  if (!isAnalyticsPlatformInPlan(ctx.tenant.planKey)) throw new ForbiddenError("module_disabled");
  return ctx;
}
const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const guard = async <T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
};
const refresh = (slug: string) => {
  revalidatePath(`/t/${slug}/integrations`);
  revalidatePath(`/t/${slug}/analytics`, "layout");
};

/**
 * A GA4 pull: queued for the worker, otherwise run inline with a time budget (a backfill left paused is
 * resumed by the next resync or by the worker). Returns whether it finished inline.
 */
async function pull(ctx: TenantContext, kind: TrafficSyncKind): Promise<{ queued: boolean; finished: boolean; rows: number; error: string | null }> {
  if (await enqueue("sync.analytics", { tenantId: ctx.tenant.id, kind }, { singletonKey: `${ctx.tenant.id}:ga4:${kind}` })) return { queued: true, finished: false, rows: 0, error: null };
  const r = await ctx.run(async (tx) => {
    const s = svc(ctx, tx);
    const p = await getAnalyticsPlatformFor(s);
    return p ? runTrafficSync(s, p.platform, { propertyId: p.propertyId, kind, timeZone: ctx.tenant.timezone, budgetMs: 20_000 }) : null;
  });
  return { queued: false, finished: r?.finished ?? false, rows: r?.rows ?? 0, error: r?.error ?? null };
}

/**
 * Default path (merchant self-setup): the store added the platform's reader e-mail as Viewer on its GA4
 * property and pastes the property id. The access is tested with the platform's key (the simulator in
 * mock mode); a failure comes back as a plain-words setup error with its fix. No store credentials are stored.
 */
export async function connectGa4Property(slug: string, _prev: ActionResult<{ verification: { property: string; rows: number; queued: string } }> | null, formData: FormData): Promise<ActionResult<{ verification: { property: string; rows: number; queued: string } }>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const propertyId = normalizeGa4PropertyId(String(formData.get("propertyId") ?? ""));
    if (!propertyId) return fail("ga4_setup", { setup: "wrong_property" });
    const live = integrationMode() === "live";
    const key = live ? platformGa4ServiceAccount() : null;
    if (live && !key) return fail("ga4_setup", { setup: "api_unreachable", platform: "HULLWISE_GA4_SERVICE_ACCOUNT_KEY" });
    const platform = key ? new Ga4AnalyticsPlatform({ kind: "service_account", serviceAccount: key }, { propertyId }) : new MockAnalyticsPlatform({ orders: [], timeZone: ctx.tenant.timezone, storeName: ctx.tenant.name, propertyId });
    const test = await platform.testConnection();
    if (!test.ok) return fail("ga4_setup", { setup: ga4SetupError(test.errorCode, test.error), platform: test.error ?? "" });
    await ctx.run(async (tx) => {
      const [prev] = await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1);
      const values = { status: "connected", mode: live ? "live" : "mock", externalAccountId: propertyId, externalAccountName: test.accountName ?? propertyId, credentialsEncrypted: null, config: { auth: "platform", serviceAccountEmail: ga4ServiceAccountEmail() }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
      await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "ga4", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "ga4", diff: { status: { from: prev?.status ?? null, to: "connected" }, property: { from: prev?.externalAccountId ?? null, to: propertyId }, auth: { from: (prev?.config as { auth?: string } | null)?.auth ?? null, to: "platform" } } });
    });
    // the verification step (#90): the property that answered and what the first import read
    const r = await pull(ctx, "backfill");
    refresh(slug);
    return ok({ verification: { property: test.accountName ?? propertyId, rows: r.rows, queued: r.queued ? "yes" : "no" } });
  });
}

const connectSchema = z.discriminatedUnion("auth", [
  z.object({ auth: z.literal("service_account"), serviceAccountJson: z.string().trim().min(50).max(20_000), propertyId: z.string().trim().min(5).max(40) }),
  z.object({ auth: z.literal("oauth"), clientId: z.string().trim().min(5), clientSecret: z.string().trim().min(5), refreshToken: z.string().trim().min(5), propertyId: z.string().trim().min(5).max(40) }),
]);

/** Live connection: the credentials are tested on the property, stored encrypted (AES-GCM), and the 12-month backfill starts. */
export async function connectGa4(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const parsed = connectSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    const propertyId = normalizeGa4PropertyId(parsed.data.propertyId);
    if (!propertyId) return fail("ga4_invalid_property");
    if (integrationMode() !== "live") return fail("mock_mode");
    let creds: Ga4Credentials;
    try {
      creds = parsed.data.auth === "service_account" ? { kind: "service_account", serviceAccount: parseGa4ServiceAccount(parsed.data.serviceAccountJson) } : { kind: "oauth", clientId: parsed.data.clientId, clientSecret: parsed.data.clientSecret, refreshToken: parsed.data.refreshToken };
    } catch (e) {
      return fail("ga4_invalid_key", { platform: e instanceof IntegrationError ? e.message : "" });
    }
    const test: ConnectionTest = await new Ga4AnalyticsPlatform(creds, { propertyId }).testConnection();
    if (!test.ok) return fail("connection_failed", { platform: test.error ?? "" });
    await ctx.run(async (tx) => {
      const [prev] = await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1);
      const values = { status: "connected", mode: "live", externalAccountId: propertyId, externalAccountName: test.accountName ?? propertyId, credentialsEncrypted: encryptJson(creds), config: { auth: creds.kind, clientEmail: creds.kind === "service_account" ? creds.serviceAccount.client_email : null }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
      await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "ga4", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "ga4", diff: { status: { from: prev?.status ?? null, to: "connected" }, property: { from: prev?.externalAccountId ?? null, to: propertyId }, auth: { from: null, to: creds.kind } } });
    });
    await pull(ctx, "backfill");
    refresh(slug);
    return ok();
  });
}

/** Mock mode: connects the simulated property (traffic built from the store's own orders) and runs the backfill inline. */
export async function connectGa4Mock(slug: string): Promise<ActionResult<{ rows: number; finished: boolean }>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const [prev] = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1));
    if (integrationMode() === "live" && prev?.mode === "live" && prev.status !== "not_connected") return fail("live_mode");
    const property = mockGa4Properties(ctx.tenant.name)[0]!;
    await ctx.run(async (tx) => {
      const values = { status: "connected", mode: "mock", externalAccountId: property.propertyId, externalAccountName: property.displayName, credentialsEncrypted: null, config: { installedVia: "mock", auth: "platform", serviceAccountEmail: ga4ServiceAccountEmail() }, lastError: null, updatedAt: new Date() };
      await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "ga4", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "ga4", diff: { status: { from: prev?.status ?? null, to: "connected" }, mode: { from: prev?.mode ?? null, to: "mock" }, property: { from: prev?.externalAccountId ?? null, to: property.propertyId } } });
    });
    const r = await pull(ctx, "backfill");
    refresh(slug);
    if (r.error) return fail("connection_failed", { platform: r.error });
    return ok({ rows: r.rows, finished: r.finished || r.queued });
  });
}

/** The properties the connected credentials can read (the picker); the simulated ones in mock mode. */
export async function listGa4Properties(slug: string): Promise<ActionResult<AnalyticsProperty[]>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const p = await ctx.run((tx) => getAnalyticsPlatformFor(svc(ctx, tx)));
    if (!p) return fail("not_connected");
    try {
      return ok(await p.platform.listProperties());
    } catch (e) {
      return fail("connection_failed", { platform: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Points the integration at another property (picker or typed id), then reads its 12 months. */
export async function setGa4Property(slug: string, propertyId: string): Promise<ActionResult<{ name: string }>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const id = normalizeGa4PropertyId(propertyId);
    if (!id) return fail("ga4_invalid_property");
    const test = await ctx.run(async (tx) => {
      const p = await getAnalyticsPlatformFor(svc(ctx, tx), { propertyId: id });
      return p ? p.platform.testConnection() : null;
    });
    if (!test) return fail("not_connected");
    if (!test.ok) return fail("ga4_setup", { setup: ga4SetupError(test.errorCode, test.error), platform: test.error ?? "" });
    const name = test.accountName ?? (integrationMode() === "mock" ? (mockGa4Properties(ctx.tenant.name).find((x) => x.propertyId === id)?.displayName ?? id) : id);
    await ctx.run(async (tx) => {
      const [prev] = await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1);
      await tx.update(schema.integrations).set({ externalAccountId: id, externalAccountName: name, lastError: null, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4")));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.property_changed", entityType: "integration", entityId: "ga4", diff: { property: { from: prev?.externalAccountId ?? null, to: id } } });
    });
    await pull(ctx, "backfill");
    refresh(slug);
    return ok({ name });
  });
}

/** Test connection: the property answers, or the plain-words reason (no access, wrong property id, API not reachable) and its fix. */
export async function testGa4(slug: string): Promise<ActionResult<ConnectionTest & { setup: Ga4SetupError | null }>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const result = await ctx.run(async (tx) => {
      let test: ConnectionTest;
      try {
        const p = await getAnalyticsPlatformFor(svc(ctx, tx));
        test = p ? await p.platform.testConnection() : { ok: false, error: "not connected" };
      } catch (e) {
        // the platform reader not configured, or an adapter that throws instead of answering
        test = { ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof IntegrationError ? { errorCode: e.code } : {}) };
      }
      await tx.update(schema.integrations).set(test.ok ? { lastSuccessAt: new Date(), lastError: null, status: "connected", updatedAt: new Date() } : { lastError: `${test.errorCode ? `[${test.errorCode}] ` : ""}${test.error ?? "connection failed"}`, status: "error", updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4")));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.tested", entityType: "integration", entityId: "ga4", diff: { ok: { from: null, to: test.ok } } });
      return { ...test, setup: test.ok ? null : ga4SetupError(test.errorCode, test.error) };
    });
    refresh(slug);
    return ok(result);
  });
}

/** Resync: resumes a paused backfill, otherwise re-reads the days since the last one. */
export async function resyncGa4(slug: string): Promise<ActionResult<{ queued: boolean; rows: number; finished: boolean }>> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    const paused = await ctx.run((tx) => tx.select({ id: schema.syncRuns.id }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenant.id), eq(schema.syncRuns.provider, "ga4"), eq(schema.syncRuns.kind, "backfill"), eq(schema.syncRuns.status, "paused"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1));
    const kind: TrafficSyncKind = paused.length ? "backfill" : "daily";
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.resync_requested", entityType: "integration", entityId: "ga4", diff: { kind: { from: null, to: kind } } }));
    const r = await pull(ctx, kind);
    refresh(slug);
    if (r.error) return fail("connection_failed", { platform: r.error });
    return ok({ queued: r.queued, rows: r.rows, finished: r.finished });
  });
}

/** Disconnects: credentials dropped, rows kept (a reconnection to the same property shows them again). */
export async function disconnectGa4(slug: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await ga4Context(slug);
    await ctx.run(async (tx) => {
      await tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, mode: "mock", lastError: null, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4")));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.disconnected", entityType: "integration", entityId: "ga4", diff: { status: { from: "connected", to: "not_connected" } } });
    });
    refresh(slug);
    return ok();
  });
}


