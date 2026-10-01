import { adminDb, and, eq, inArray, schema, withTenant } from "@keel/db";
import { applySuspensions, getAdsPlatformFor, getCommercePlatformFor, issueDueInvoices, processWebhookEvent, retryFailedWebhooks, runAdsSync, runCatalogSync, runOrdersSync, type ServiceContext } from "@keel/services";
import { distributeUnassigned, recomputeRecipientProfiles, scorePendingItems, syncQueue } from "@keel/addon-cod";
import { adsWindow, type SyncAdsJob, type SyncCatalogJob, type SyncOrdersJob, type TickJob, type WebhookJob } from "./queues";

export interface Enqueue {
  (queue: string, data: unknown, opts?: { singletonKey?: string }): Promise<void>;
}

async function tenantRow(tenantId: string) {
  const [t] = await adminDb().select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!t) throw new Error(`tenant ${tenantId} not found`);
  return t;
}
const sys = (tenantId: string) => (tx: ServiceContext["tx"]): ServiceContext => ({ tenantId, tx, actor: { type: "system", userId: null } });

export async function handleWebhook(job: WebhookJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    const platform = await getCommercePlatformFor(ctx, tenant);
    const r = await processWebhookEvent(ctx, platform, job.eventId, { country: tenant.country });
    if (r.status === "failed") throw new Error(r.error ?? "webhook failed");
  });
}

export async function handleSyncOrders(job: SyncOrdersJob, enqueue: Enqueue): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const result = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    const platform = await getCommercePlatformFor(ctx, tenant);
    return runOrdersSync(ctx, platform, { kind: job.kind, country: tenant.country, budgetMs: 25_000 });
  });
  // Resumable: a paused run re-enqueues itself with the saved cursor.
  if (!result.finished && !result.error) await enqueue("sync.orders", job, { singletonKey: `${job.tenantId}:${job.kind}` });
  if (result.error) throw new Error(result.error);
}

export async function handleSyncCatalog(job: SyncCatalogJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const r = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runCatalogSync(ctx, await getCommercePlatformFor(ctx, tenant));
  });
  if (r.error) throw new Error(r.error);
}

export async function handleSyncAds(job: SyncAdsJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const r = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runAdsSync(ctx, await getAdsPlatformFor(ctx, tenant, job.provider), { since: job.since, until: job.until });
  });
  if (r.error) throw new Error(r.error);
}

/** Fan-out: one job per connected tenant/provider, deduplicated by singleton key. */
export async function handleTick(job: TickJob, enqueue: Enqueue): Promise<void> {
  if (job.kind === "cod") {
    // add-on tick: only tenants with addon.cod active; queue sync, scoring, auto-assignment, risk profiles once a day
    const addons = await adminDb().select({ tenantId: schema.tenantAddons.tenantId }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.moduleKey, "addon.cod"), eq(schema.tenantAddons.isActive, true)));
    for (const a of addons) {
      const [t] = await adminDb().select({ id: schema.tenants.id, timezone: schema.tenants.timezone, country: schema.tenants.country, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, a.tenantId)).limit(1);
      if (!t || t.status !== "active") continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        await syncQueue(ctx);
        await scorePendingItems(ctx, { limit: 200, timezone: t.timezone });
        await distributeUnassigned(ctx, { source: "cron", timezone: t.timezone, limit: 200 });
        if (new Date().getUTCHours() === 2) await recomputeRecipientProfiles(ctx, undefined, t.country);
      });
    }
    return;
  }
  if (job.kind === "billing") {
    await issueDueInvoices(adminDb());
    await applySuspensions(adminDb());
    return;
  }
  const rows = await adminDb().select({ tenantId: schema.integrations.tenantId, provider: schema.integrations.provider }).from(schema.integrations).where(and(inArray(schema.integrations.provider, ["shopify", "meta", "google"]), inArray(schema.integrations.status, ["connected", "error", "syncing"])));
  const active = new Set((await adminDb().select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.status, "active"))).map((t) => t.id));
  const window = adsWindow();
  for (const r of rows) {
    if (!active.has(r.tenantId)) continue;
    if (r.provider === "shopify") {
      if (job.kind === "delta") await enqueue("sync.orders", { tenantId: r.tenantId, kind: "delta" } satisfies SyncOrdersJob, { singletonKey: `${r.tenantId}:delta` });
      if (job.kind === "reconcile") {
        await enqueue("sync.orders", { tenantId: r.tenantId, kind: "reconcile" } satisfies SyncOrdersJob, { singletonKey: `${r.tenantId}:reconcile` });
        await enqueue("sync.catalog", { tenantId: r.tenantId } satisfies SyncCatalogJob, { singletonKey: `${r.tenantId}:catalog` });
      }
      if (job.kind === "retry") {
        const tenant = await tenantRow(r.tenantId);
        await withTenant(tenant.id, async (tx) => {
          const ctx = sys(tenant.id)(tx);
          await retryFailedWebhooks(ctx, await getCommercePlatformFor(ctx, tenant), { country: tenant.country });
        });
      }
    } else if (job.kind === "ads") {
      await enqueue("sync.ads", { tenantId: r.tenantId, provider: r.provider as "meta" | "google", ...window } satisfies SyncAdsJob, { singletonKey: `${r.tenantId}:${r.provider}:${window.until}` });
    }
  }
}
