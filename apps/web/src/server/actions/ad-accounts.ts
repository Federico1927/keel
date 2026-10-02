"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema, sql } from "@hullwise/db";
import { normalizeMetaAccountId } from "@hullwise/core";
import { MetaAdsPlatform, decryptJson, encryptJson, integrationMode, type ConnectionTest, type MetaCredentials } from "@hullwise/integrations";
import { AdAccountError, addAdAccount, getAdAccount, getAdsPlatformFor, recordAdAccountRun, removeAdAccount, runAdsSyncForAccounts, type ServiceContext } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Meta ad accounts of a store (#82): add (live with the account id and, optionally, its own token;
 * in mock mode a simulated account), test, resync and remove. The primary account is the Meta
 * integration itself and is managed from its card.
 */

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const runner = (ctx: TenantContext) => <T>(fn: (s: ServiceContext) => Promise<T>) => ctx.run((tx) => fn(svc(ctx, tx)));
const days = (n: number) => ({ since: new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10), until: new Date().toISOString().slice(0, 10) });
const accountError = (e: unknown): ActionResult | null => (e instanceof AdAccountError ? fail(`ad_account_${e.code}`) : null);

function done(slug: string) {
  revalidatePath(`/t/${slug}/integrations`);
  revalidatePath(`/t/${slug}/campaigns`, "layout");
}

/** First import of a new account: 90 days on the worker (it resumes itself in windows). */
async function queueBackfill(ctx: TenantContext, account: string): Promise<boolean> {
  const w = days(90);
  return enqueue("sync.ads", { tenantId: ctx.tenant.id, provider: "meta", ...w, kind: "backfill", accountExternalId: account }, { singletonKey: `${ctx.tenant.id}:meta:backfill:${w.until}:${account}` });
}

/** Mock mode: a simulated Meta account with a few campaigns, imported inline (30 days; the rest on the worker). */
export async function addMetaAdAccountMock(slug: string): Promise<ActionResult<{ account: string; summary: string }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const run = runner(ctx);
    const [integ] = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "meta"))).limit(1));
    if (integrationMode() === "live" && integ?.mode === "live" && integ.status !== "not_connected") return fail("live_mode");
    const account = await run(async (s) => {
      const [n] = await s.tx.select({ n: sql<number>`count(*)::int` }).from(schema.adAccounts).where(and(eq(schema.adAccounts.tenantId, ctx.tenant.id), eq(schema.adAccounts.provider, "meta")));
      let i = (n?.n ?? 0) + 1;
      while (await getAdAccount(s, "meta", { externalId: `act_mock_${i}` })) i++;
      return addAdAccount(s, "meta", { externalAccountId: `act_mock_${i}`, name: `${ctx.tenant.name} (Meta demo ${i})`, mode: "mock", credentialsEncrypted: null }, auditActor(ctx));
    });
    const r = await runAdsSyncForAccounts(run, ctx.tenant, "meta", { ...days(30), account: account.externalAccountId, budgetMs: 15_000 });
    if (r.paused.length) await queueBackfill(ctx, account.externalAccountId);
    done(slug);
    const failed = r.results.find((x) => !x.ok);
    if (failed) return fail("connection_failed", { platform: failed.error ?? "" });
    return ok({ account: account.name, summary: `campaigns:${r.campaigns} metrics:${r.metrics}` });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const a = accountError(e);
    if (a) return a as ActionResult<never>;
    throw e;
  }
}

const addSchema = z.object({ adAccountId: z.string().trim().min(3).max(48), name: z.string().trim().max(120).optional().default(""), accessToken: z.string().trim().max(500).optional().default("") });

/** Live: checks the account with its own token, or the integration's when left empty, then queues its 90-day import. */
export async function addMetaAdAccount(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    const parsed = addSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const adAccountId = normalizeMetaAccountId(parsed.data.adAccountId);
    const [integ] = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "meta"))).limit(1));
    const token = parsed.data.accessToken || (integ?.credentialsEncrypted ? decryptJson<MetaCredentials>(integ.credentialsEncrypted).accessToken : "");
    if (!token) return fail("ad_account_not_connected");
    const test: ConnectionTest = await new MetaAdsPlatform({ accessToken: token, adAccountId }).testConnection();
    if (!test.ok) return fail("connection_failed", { platform: test.error ?? "" });
    await runner(ctx)((s) => addAdAccount(s, "meta", { externalAccountId: adAccountId, name: parsed.data.name || test.accountName || adAccountId, mode: "live", credentialsEncrypted: parsed.data.accessToken ? encryptJson({ accessToken: parsed.data.accessToken, adAccountId } satisfies MetaCredentials) : null }, auditActor(ctx)));
    if (!(await queueBackfill(ctx, adAccountId))) await runAdsSyncForAccounts(runner(ctx), ctx.tenant, "meta", { ...days(30), account: adAccountId, budgetMs: 15_000 });
    done(slug);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const a = accountError(e);
    if (a) return a;
    throw e;
  }
}

export async function removeMetaAdAccount(slug: string, accountId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    if (!z.string().uuid().safeParse(accountId).success) return fail("invalid_input");
    await runner(ctx)((s) => removeAdAccount(s, "meta", accountId, auditActor(ctx)));
    done(slug);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const a = accountError(e);
    if (a) return a;
    throw e;
  }
}

/** "Test connection" of one account: the outcome lands on its row (status, last error, name). */
export async function testMetaAdAccount(slug: string, accountId: string): Promise<ActionResult<ConnectionTest>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    if (!z.string().uuid().safeParse(accountId).success) return fail("invalid_input");
    const result = await runner(ctx)(async (s) => {
      const acc = await getAdAccount(s, "meta", { id: accountId });
      if (!acc || acc.status === "not_connected") throw new AdAccountError("not_found");
      const platform = await getAdsPlatformFor(s, ctx.tenant, "meta", { account: acc.externalAccountId });
      const test = await platform.testConnection().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as ConnectionTest);
      await recordAdAccountRun(s, "meta", acc.externalAccountId, { ok: test.ok, error: test.error ?? null, name: acc.isPrimary ? null : (test.accountName ?? null) });
      await recordAudit(s.tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "ad_account.tested", entityType: "ad_account", entityId: acc.id, diff: { ok: { from: null, to: test.ok } } });
      return test;
    });
    revalidatePath(`/t/${slug}/integrations`);
    return ok(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const a = accountError(e);
    if (a) return a as ActionResult<never>;
    throw e;
  }
}

/** "Resync" of one account: queued when a worker runs, otherwise campaigns and the last 30 days inline. */
export async function resyncMetaAdAccount(slug: string, accountId: string): Promise<ActionResult<{ queued: boolean; summary: string }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "integrations");
    if (!z.string().uuid().safeParse(accountId).success) return fail("invalid_input");
    const acc = await runner(ctx)((s) => getAdAccount(s, "meta", { id: accountId }));
    if (!acc || acc.status === "not_connected") return fail("ad_account_not_found");
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "ad_account.resync_requested", entityType: "ad_account", entityId: acc.id }));
    const w = days(30);
    const queued = await enqueue("sync.ads", { tenantId: ctx.tenant.id, provider: "meta", ...w, accountExternalId: acc.externalAccountId }, { singletonKey: `${ctx.tenant.id}:meta:${w.until}:${acc.externalAccountId}` });
    let summary = "queued";
    if (!queued) {
      const r = await runAdsSyncForAccounts(runner(ctx), ctx.tenant, "meta", { ...w, account: acc.externalAccountId, entities: false });
      summary = r.results[0]?.error ?? `campaigns:${r.campaigns} metrics:${r.metrics}`;
    }
    done(slug);
    return ok({ queued, summary });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
