import { platformRetentionDays } from "@keel/config";
import { parseTenantSettings } from "@keel/core";
import { adminDb, and, eq, inArray, lte, schema, withTenant } from "@keel/db";
import { recheckOpenBackorders, checkCriticalStock, checkLateToShip, checkSyncDelays, remindOverdueTasks, sendDigests, sweepTaskRules, enqueueConversions, getConversionSinkFor, sendDueConversions, stitchPixelSessions, getAudienceDestinationFor, recomputePredictions, refreshLiveSegments, syncAutoDestinations, applySuspensions, captureOverdueGuarantees, runListExport, evaluateAlertRules, purgeOrphanEvidence, returnsToSync, syncReturnToPlatform, executePlatformWrite, processDuePlatformWrites, purgeExpiredPlatformRows, getAdsPlatformFor, getCommercePlatformFor, issueDueInvoices, processWebhookEvent, retryFailedWebhooks, runAdsSync, runCatalogSync, runOrdersSync, type ServiceContext } from "@keel/services";
import { distributeUnassigned, recomputeRecipientProfiles, scorePendingItems, syncQueue } from "@keel/addon-cod";
import { adsWindow, type ListExportJob, type PlatformWriteJob, type SyncAdsJob, type SyncCatalogJob, type SyncOrdersJob, type TickJob, type WebhookJob } from "./queues";

export interface Enqueue {
  (queue: string, data: unknown, opts?: { singletonKey?: string }): Promise<void>;
}

async function tenantRow(tenantId: string) {
  const [t] = await adminDb().select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!t) throw new Error(`tenant ${tenantId} not found`);
  return t;
}
const sys = (tenantId: string) => (tx: ServiceContext["tx"]): ServiceContext => ({ tenantId, tx, actor: { type: "system", userId: null } });
/** Short tenant transactions on demand: the outbox never holds one across a platform call. */
const runner = (tenantId: string) => <T>(fn: (ctx: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn(sys(tenantId)(tx)));

export async function handleWebhook(job: WebhookJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    const platform = await getCommercePlatformFor(ctx, tenant);
    const r = await processWebhookEvent(ctx, platform, job.eventId, { country: tenant.country });
    if (r.status === "failed") throw new Error(r.error ?? "webhook failed");
  });
}

/** Builds a queued CSV export, stores the file and notifies the user who asked for it. */
export async function handleListExport(job: ListExportJob): Promise<void> {
  await withTenant(job.tenantId, (tx) => runListExport(sys(job.tenantId)(tx), job.exportId));
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

export async function handleSyncCatalog(job: SyncCatalogJob, enqueue?: Enqueue): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const r = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runCatalogSync(ctx, await getCommercePlatformFor(ctx, tenant), { kind: job.kind ?? "delta", scope: job.scope ?? "catalog", budgetMs: 25_000 });
  });
  // Resumable: a paused run re-enqueues itself and continues from the saved phase and cursor.
  if (!r.finished && !r.error && enqueue) await enqueue("sync.catalog", job, { singletonKey: `${job.tenantId}:catalog:${job.scope ?? "catalog"}` });
  if (r.error) throw new Error(r.error);
}

/** One outbox write. Platform errors are not thrown: the outbox owns retries (backoff, rate limits), pg-boss only infrastructure failures. */
export async function handlePlatformWrite(job: PlatformWriteJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  await executePlatformWrite(runner(tenant.id), tenant, job.writeId);
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
  if (job.kind === "alerts") {
    // alert rules of every active tenant: threshold and anomaly checks on yesterday's closed day
    const tenants = await adminDb().select({ id: schema.tenants.id, slug: schema.tenants.slug, country: schema.tenants.country, currency: schema.tenants.currency, timezone: schema.tenants.timezone, settings: schema.tenants.settings, status: schema.tenants.status }).from(schema.tenants);
    for (const t of tenants) {
      if (t.status !== "active") continue;
      await withTenant(t.id, async (tx) => {
        await evaluateAlertRules(sys(t.id)(tx), { id: t.id, country: t.country, currency: t.currency, timezone: t.timezone, settings: parseTenantSettings(t.settings) }, { appUrl: process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/t/${t.slug}` : undefined });
      });
    }
    return;
  }
  if (job.kind === "tracking") {
    // pixel sessions → orders placed since the last ticks, then the server-side conversion queue
    const tenants = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status }).from(schema.tenants);
    const withPixel = new Set((await adminDb().select({ tenantId: schema.pixelSettings.tenantId }).from(schema.pixelSettings)).map((r) => r.tenantId));
    const withConversions = new Set((await adminDb().select({ tenantId: schema.conversionSettings.tenantId }).from(schema.conversionSettings).where(eq(schema.conversionSettings.enabled, true))).map((r) => r.tenantId));
    for (const t of tenants) {
      if (t.status !== "active" || (!withPixel.has(t.id) && !withConversions.has(t.id))) continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        if (withPixel.has(t.id)) await stitchPixelSessions(ctx, { orderSinceHours: 2 });
        if (withConversions.has(t.id)) {
          await enqueueConversions(ctx);
          await sendDueConversions(ctx, (provider, settings) => getConversionSinkFor(ctx, provider, settings));
        }
      });
    }
    return;
  }
  if (job.kind === "crm" || job.kind === "segments") {
    // crm (nightly, after the reconciliation): refit predictions, then fully re-evaluate live segments,
    // since time-based conditions and predictions change without events.
    // segments (every 10 min): live segments re-checked for customers whose orders changed.
    // Either way, destinations of segments whose membership changed are synced.
    const full = job.kind === "crm";
    const tenants = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, settings: schema.tenants.settings }).from(schema.tenants);
    const campaigns = new Set((await adminDb().select({ tenantId: schema.tenantAddons.tenantId }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns"), eq(schema.tenantAddons.isActive, true)))).map((a) => a.tenantId));
    for (const t of tenants) {
      if (t.status !== "active") continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        if (full) await recomputePredictions(ctx, parseTenantSettings(t.settings));
        const deltas = await refreshLiveSegments(ctx, { full });
        const changed = deltas.filter((d) => full || d.added + d.removed > 0).map((d) => d.segmentId);
        await syncAutoDestinations(ctx, changed, (provider) => getAudienceDestinationFor(t.id, provider), { excludeHoldout: campaigns.has(t.id) });
      });
    }
    return;
  }
  if (job.kind === "returns") {
    // returns not yet written to the commerce platform, or that failed: retry; photos of abandoned portal sessions: purge
    const pending = await adminDb().selectDistinct({ tenantId: schema.returnRequests.tenantId }).from(schema.returnRequests).where(inArray(schema.returnRequests.platformSyncStatus, ["pending", "error"]));
    for (const p of pending) {
      const [t] = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, p.tenantId)).limit(1);
      if (!t || t.status !== "active") continue;
      const settings = parseTenantSettings(t.settings);
      const ids = await withTenant(t.id, (tx) => returnsToSync(sys(t.id)(tx)));
      for (const id of ids) await withTenant(t.id, async (tx) => syncReturnToPlatform(sys(t.id)(tx), await getCommercePlatformFor(sys(t.id)(tx), t), settings, id, { country: t.country }));
    }
    // instant exchanges whose goods never came back
    const holds = await adminDb().selectDistinct({ tenantId: schema.returnRequests.tenantId }).from(schema.returnRequests).where(eq(schema.returnRequests.guaranteeStatus, "authorized"));
    for (const h of holds) await withTenant(h.tenantId, (tx) => captureOverdueGuarantees(sys(h.tenantId)(tx)));
    if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 10) {
      for (const t of await adminDb().select({ id: schema.tenants.id }).from(schema.tenants)) await withTenant(t.id, (tx) => purgeOrphanEvidence(sys(t.id)(tx)));
    }
    return;
  }
  if (job.kind === "cod") {
    // add-on tick: only tenants with addon.cod active; queue sync, scoring, auto-assignment, risk profiles once a day
    const addons = await adminDb().select({ tenantId: schema.tenantAddons.tenantId }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.moduleKey, "addon.cod"), eq(schema.tenantAddons.isActive, true)));
    for (const a of addons) {
      const [t] = await adminDb().select({ id: schema.tenants.id, timezone: schema.tenants.timezone, country: schema.tenants.country, status: schema.tenants.status, currency: schema.tenants.currency, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, a.tenantId)).limit(1);
      if (!t || t.status !== "active") continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        await syncQueue(ctx, undefined, { platform: await getCommercePlatformFor(ctx, t) });
        await scorePendingItems(ctx, { limit: 200, timezone: t.timezone });
        await distributeUnassigned(ctx, { source: "cron", timezone: t.timezone, limit: 200 });
        if (new Date().getUTCHours() === 2) await recomputeRecipientProfiles(ctx, undefined, t.country);
      });
    }
    return;
  }
  if (job.kind === "writes") {
    // outbox retries: tenants with writes due (rescheduled after a rate limit or a network error, or left running by a restart)
    const due = await adminDb().selectDistinct({ tenantId: schema.platformWrites.tenantId }).from(schema.platformWrites).where(and(eq(schema.platformWrites.mode, "async"), inArray(schema.platformWrites.status, ["pending", "running"]), lte(schema.platformWrites.nextAttemptAt, new Date())));
    for (const d of due) {
      const tenant = await tenantRow(d.tenantId);
      if (tenant.status !== "active") continue;
      await processDuePlatformWrites(runner(tenant.id), tenant);
    }
    return;
  }
  if (job.kind === "backorders") {
    // safety net: open backorders re-checked against current stock and incoming POs; covered orders are released
    // (their platform holds go out through the outbox, picked up by the "writes" tick)
    const open = await adminDb().selectDistinct({ tenantId: schema.backorders.tenantId }).from(schema.backorders).where(inArray(schema.backorders.status, ["pending", "covered"]));
    for (const o of open) {
      const tenant = await tenantRow(o.tenantId);
      if (tenant.status !== "active") continue;
      await withTenant(tenant.id, (tx) => recheckOpenBackorders(sys(tenant.id)(tx)));
    }
    return;
  }
  if (job.kind === "retention") {
    // platform-wide window (KEEL_RETENTION_DAYS, default 14): finished history goes, failures stay until resolved
    const days = platformRetentionDays();
    for (const t of await adminDb().select({ id: schema.tenants.id }).from(schema.tenants)) await withTenant(t.id, (tx) => purgeExpiredPlatformRows(sys(t.id)(tx), { days }));
    return;
  }
  if (job.kind === "tasks" || job.kind === "notify" || job.kind === "digest") {
    // tasks (every 10 min): task rules (time-based ones, orders, closing what moved on) and overdue reminders;
    // notify (hourly): sync delays, critical stock without incoming PO, late to ship; digest (daily): opt-in summary email
    const tenants = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, settings: schema.tenants.settings }).from(schema.tenants);
    for (const t of tenants) {
      if (t.status !== "active") continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        const settings = parseTenantSettings(t.settings);
        if (job.kind === "tasks") {
          await sweepTaskRules(ctx);
          await remindOverdueTasks(ctx);
        } else if (job.kind === "notify") {
          await checkSyncDelays(ctx, settings);
          await checkCriticalStock(ctx, settings);
          await checkLateToShip(ctx, settings);
        } else await sendDigests(ctx);
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
        await enqueue("sync.catalog", { tenantId: r.tenantId, kind: "reconcile" } satisfies SyncCatalogJob, { singletonKey: `${r.tenantId}:catalog:catalog` });
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
