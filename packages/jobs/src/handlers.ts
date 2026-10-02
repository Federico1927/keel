import { AD_PLATFORMS, OPERATIONAL_TENANT_STATUSES, appUrl, isAdPlatform, isAdPlatformInPlan, isTenantOperational, platformRetentionDays } from "@hullwise/config";
import { historyImportSince, parseTenantSettings } from "@hullwise/core";
import { adminDb, and, eq, inArray, lte, schema, withTenant } from "@hullwise/db";
import { recheckOpenBackorders, checkCriticalStock, checkLateToShip, remindOverdueTasks, sendDigests, sweepTaskRules, enqueueConversions, getConversionSinkFor, sendDueConversions, stitchPixelSessions, getAudienceDestinationFor, recomputePredictions, refreshLiveSegments, syncAutoDestinations, applySuspensions, captureOverdueGuarantees, runListExport, evaluateAlertRules, purgeOrphanEvidence, returnsToSync, syncReturnToPlatform, executePlatformWrite, processDuePlatformWrites, purgeExpiredPlatformRows, getAdsPlatformFor, getCommercePlatformFor, issueDueInvoices, processWebhookEvent, retryFailedWebhooks, runAdsSync, runCatalogSync, runOrdersSync, runPayoutsSync, runReturnsSync, type ServiceContext, syncShipmentCases, deliverEmailJob, processEmailEvent, purgeEmailRows, retryEmailEvents, sweepLostEmails, processBillingEvent, retryBillingEvents, purgeBillingEvents, runWatchdog, raisePlatformAlert, resolveRecoveredSourceAlerts, runTenantExport, purgeExpiredAudit, purgeExpiredTenantExports, purgeJobRuns, type JobOutcome, runAdsEntitySync, rollupAdEntityMetrics, campaignTick, processCampaignSend, getMessagingChannelFor, resolveAddressProvider, SUBSCRIPTIONS_ADDON, getSubscriptionProviderFor, runSubscriptionSync, refreshSubscriberRisk } from "@hullwise/services";
import { distributeUnassigned, recomputeRecipientProfiles, scorePendingItems, syncQueue, autoCancelReturnedToSender, getCodSettings, runScheduledConfirmations } from "@hullwise/addon-cod";
import { adsWindow, type CampaignSendJob, type ListExportJob, type PlatformWriteJob, type SyncAdsJob, type SyncCatalogJob, type SyncOrdersJob, type SyncPayoutsJob, type SyncReturnsJob, type TickJob, type WebhookJob, type EmailEventJob, type EmailSendJob, type BillingEventJob, resyncJobsFor, type TenantExportJob } from "./queues";

export interface Enqueue {
  (queue: string, data: unknown, opts?: { singletonKey?: string; startAfterSeconds?: number }): Promise<void>;
}

async function tenantRow(tenantId: string) {
  const [t] = await adminDb().select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix, status: schema.tenants.status, planKey: schema.tenants.planKey }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
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

/**
 * One email delivery. The mailer owns provider retries (backoff, rate limits): a retry is a new job
 * delayed by what it asks. A row not visible yet (the queueing transaction has not committed) is
 * thrown, so pg-boss tries again shortly; a rolled-back email simply never appears.
 */
export async function handleEmailSend(job: EmailSendJob, enqueue: Enqueue): Promise<void> {
  const r = await deliverEmailJob(adminDb(), job);
  if (r.status === "missing") throw new Error(`email ${job.messageId} not visible yet`);
  if (r.retryInMs !== undefined) await enqueue("email.send", job, { startAfterSeconds: Math.ceil(r.retryInMs / 1000) });
}

/** A stored Resend event: status on the log row, bounces and complaints to the suppression list. */
export async function handleEmailEvent(job: EmailEventJob): Promise<void> {
  const r = await processEmailEvent(adminDb(), job.eventId);
  if (r === "failed") throw new Error(`email event ${job.eventId} failed`);
}

/** A stored Stripe event (#53): subscription and invoice mirror, tenant lifecycle. */
export async function handleBillingEvent(job: BillingEventJob): Promise<void> {
  const r = await processBillingEvent(adminDb(), job.eventId);
  if (r === "failed") throw new Error(`billing event ${job.eventId} failed`);
}

/** Builds a queued CSV export, stores the file and notifies the user who asked for it. */
export async function handleListExport(job: ListExportJob): Promise<void> {
  await withTenant(job.tenantId, (tx) => runListExport(sys(job.tenantId)(tx), job.exportId));
}

/** Builds a tenant's full data export (#32) inside its RLS transaction. */
export async function handleTenantExport(job: TenantExportJob): Promise<JobOutcome> {
  const r = await withTenant(job.tenantId, (tx) => runTenantExport(sys(job.tenantId)(tx), job.exportId));
  if (r.status === "failed") throw new Error(`tenant export ${job.exportId} failed`);
  return { rows: r.rows, summary: { tables: r.tables, status: r.status } };
}

/** The first import's window (issue #87): read when a run starts; a resumed run keeps the one in its cursor. */
async function historySince(tenantId: string): Promise<Date | null> {
  const [row] = await adminDb().select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return historyImportSince(new Date(), parseTenantSettings(row?.settings).historyImportMonths);
}

export async function handleSyncOrders(job: SyncOrdersJob, enqueue: Enqueue): Promise<JobOutcome> {
  const tenant = await tenantRow(job.tenantId);
  const since = job.kind === "initial" ? await historySince(tenant.id) : null;
  const result = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    const platform = await getCommercePlatformFor(ctx, tenant);
    return runOrdersSync(ctx, platform, { kind: job.kind, country: tenant.country, budgetMs: 25_000, historySince: since });
  });
  // Resumable: a paused run re-enqueues itself with the saved cursor.
  if (!result.finished && !result.error) await enqueue("sync.orders", job, { singletonKey: `${job.tenantId}:${job.kind}` });
  // the first returns import follows the orders it belongs to: a return of an order not imported yet would be skipped
  if (result.finished && job.kind === "initial") await enqueue("sync.returns", { tenantId: job.tenantId, kind: "initial" } satisfies SyncReturnsJob, { singletonKey: `${job.tenantId}:returns` });
  if (result.error) throw new Error(result.error);
  return { rows: result.rowsWritten, summary: { finished: result.finished } };
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

/** Payouts and balance transactions; a paused run re-enqueues itself and resumes from its cursor. */
export async function handleSyncPayouts(job: SyncPayoutsJob, enqueue?: Enqueue): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const r = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runPayoutsSync(ctx, await getCommercePlatformFor(ctx, tenant), { budgetMs: 25_000 });
  });
  if (!r.finished && !r.error && enqueue) await enqueue("sync.payouts", job, { singletonKey: `${job.tenantId}:payouts` });
  if (r.error) throw new Error(r.error);
}

/** Platform returns (webhooks catch them live; this is the nightly safety net); a paused run re-enqueues itself. */
export async function handleSyncReturns(job: SyncReturnsJob, enqueue?: Enqueue): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  const since = job.kind === "initial" ? await historySince(tenant.id) : null;
  const r = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runReturnsSync(ctx, await getCommercePlatformFor(ctx, tenant), { kind: job.kind ?? "reconcile", country: tenant.country, budgetMs: 25_000, historySince: since });
  });
  if (!r.finished && !r.error && enqueue) await enqueue("sync.returns", job, { singletonKey: `${job.tenantId}:returns` });
  if (r.error) throw new Error(r.error);
}

/** One outbox write. Platform errors are not thrown: the outbox owns retries (backoff, rate limits), pg-boss only infrastructure failures. */
export async function handlePlatformWrite(job: PlatformWriteJob): Promise<void> {
  const tenant = await tenantRow(job.tenantId);
  await executePlatformWrite(runner(tenant.id), tenant, job.writeId);
}

/**
 * Campaigns and daily insights, then the levels below the campaign (issue #40) in resumable 7-day
 * windows. A paused entity run (time budget, rate limit) re-enqueues itself, after the platform's wait.
 */
export async function handleSyncAds(job: SyncAdsJob, enqueue?: Enqueue): Promise<JobOutcome> {
  const tenant = await tenantRow(job.tenantId);
  // a platform outside the tenant's plan (TikTok below Growth) is never pulled, whoever queued the job
  if (!isAdPlatformInPlan(job.provider, tenant.planKey)) return { rows: 0, summary: { skipped: "not_in_plan", provider: job.provider } };
  let campaigns = 0, metrics = 0;
  if (job.phase !== "entities") {
    const r = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id)(tx);
      return runAdsSync(ctx, await getAdsPlatformFor(ctx, tenant, job.provider), { since: job.since, until: job.until });
    });
    if (r.error) throw new Error(r.error);
    campaigns = r.campaigns;
    metrics = r.metrics;
  }
  const settings = parseTenantSettings((await adminDb().select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenant.id)).limit(1))[0]?.settings);
  const e = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id)(tx);
    return runAdsEntitySync(ctx, await getAdsPlatformFor(ctx, tenant, job.provider), { since: job.since, until: job.until, kind: job.kind ?? "delta", budgetMs: 25_000, minImpressions: settings.adsSearchTermMinImpressions });
  });
  if (!e.finished && !e.error && enqueue) await enqueue("sync.ads", { ...job, phase: "entities" } satisfies SyncAdsJob, { singletonKey: `${job.tenantId}:${job.provider}:entities${job.kind === "backfill" ? ":backfill" : ""}`, ...(e.rateLimited ? { startAfterSeconds: Math.ceil((e.retryAfterMs ?? 60_000) / 1000) } : {}) });
  if (e.error) throw new Error(e.error);
  return { rows: campaigns + metrics, summary: { campaigns, metrics, phase: job.phase ?? "campaigns", entitiesFinished: e.finished } };
}

async function campaignTenant(tenantId: string) {
  const [t] = await adminDb().select({ id: schema.tenants.id, timezone: schema.tenants.timezone, settings: schema.tenants.settings, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return t ? { id: t.id, timezone: t.timezone, settings: parseTenantSettings(t.settings), status: t.status } : null;
}

const hasCampaignsAddon = async (tenantId: string) => (await adminDb().select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns"), eq(schema.tenantAddons.isActive, true))).limit(1)).length > 0;

/**
 * One campaign's send queue (#34): batches within the send window and the channel throttle for up
 * to 25 s. Provider errors are the queue's own retries (backoff per message), never pg-boss's; what
 * is left goes on with the next minute's tick. Add-on switched off or tenant blocked: nothing is sent.
 */
export async function handleCampaignSend(job: CampaignSendJob): Promise<JobOutcome> {
  const tenant = await campaignTenant(job.tenantId);
  if (!tenant || !isTenantOperational(tenant.status) || !(await hasCampaignsAddon(tenant.id))) return { rows: 0, summary: { skipped: "not_enabled" } };
  const r = await processCampaignSend(runner(tenant.id), tenant, job.campaignId, getMessagingChannelFor(tenant.id));
  return { rows: r.sent, summary: { status: r.status, sent: r.sent, failed: r.failed, suppressed: r.suppressed, remaining: r.remaining } };
}

/** Fan-out: one job per connected tenant/provider, deduplicated by singleton key. */
export async function handleTick(job: TickJob, enqueue: Enqueue): Promise<JobOutcome | void> {
  if (job.kind === "campaigns") {
    // customer campaigns (add-on): due one-offs start, sequences enrol, every delivering campaign gets its send job
    const addons = await adminDb().select({ tenantId: schema.tenantAddons.tenantId }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns"), eq(schema.tenantAddons.isActive, true)));
    let started = 0, enrolled = 0, queued = 0;
    for (const a of addons) {
      const tenant = await campaignTenant(a.tenantId);
      if (!tenant || !isTenantOperational(tenant.status)) continue;
      const r = await campaignTick(runner(tenant.id), tenant);
      started += r.started.length;
      enrolled += r.enrolled;
      for (const campaignId of r.delivering) {
        await enqueue("campaign.send", { tenantId: tenant.id, campaignId } satisfies CampaignSendJob, { singletonKey: `campaign:${campaignId}` });
        queued++;
      }
    }
    return { rows: started + enrolled, summary: { started, enrolled, sendJobs: queued } };
  }
  if (job.kind === "watchdog") {
    // stale and idle integration sources (#32): status, automatic resync, owner/admin notice, platform alert
    const tenants = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, settings: schema.tenants.settings }).from(schema.tenants);
    let checked = 0, stale = 0, idle = 0, resyncs = 0;
    for (const t of tenants) {
      if (!isTenantOperational(t.status)) continue;
      const r = await withTenant(t.id, (tx) => runWatchdog(sys(t.id)(tx), parseTenantSettings(t.settings)));
      checked += r.checked;
      stale += r.stale.length;
      idle += r.idle.length;
      for (const s of r.resync) for (const q of resyncJobsFor(t.id, s.source)) {
        await enqueue(q.queue, q.data, { singletonKey: q.singletonKey });
        resyncs++;
      }
      // the tenant side of a stale source is the watchdog notice above: the alert goes to the super-admins
      for (const s of r.stale) await raisePlatformAlert(adminDb(), { kind: "sync_stale", tenantId: t.id, subject: s.source, error: null, meta: { minutesLate: s.minutesLate } }, { notifyTenant: false });
      await resolveRecoveredSourceAlerts(adminDb(), t.id, r.stale.map((s) => s.source));
    }
    return { rows: stale + idle, summary: { checked, stale, idle, resyncs } };
  }
  if (job.kind === "alerts") {
    // alert rules of every active tenant: threshold and anomaly checks on yesterday's closed day
    const tenants = await adminDb().select({ id: schema.tenants.id, slug: schema.tenants.slug, country: schema.tenants.country, currency: schema.tenants.currency, timezone: schema.tenants.timezone, settings: schema.tenants.settings, status: schema.tenants.status }).from(schema.tenants);
    for (const t of tenants) {
      if (!isTenantOperational(t.status)) continue;
      await withTenant(t.id, async (tx) => {
        await evaluateAlertRules(sys(t.id)(tx), { id: t.id, country: t.country, currency: t.currency, timezone: t.timezone, settings: parseTenantSettings(t.settings) }, { appUrl: `${appUrl()}/t/${t.slug}` });
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
      if (!isTenantOperational(t.status) || (!withPixel.has(t.id) && !withConversions.has(t.id))) continue;
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
      if (!isTenantOperational(t.status)) continue;
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
      if (!t || !isTenantOperational(t.status)) continue;
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
      if (!t || !isTenantOperational(t.status)) continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        const settings = await getCodSettings(ctx);
        const platform = await getCommercePlatformFor(ctx, t);
        await syncQueue(ctx, settings, { platform });
        // confirmations agreed for today (from the configured hour; a refused platform call waits for the next day's run)
        await runScheduledConfirmations(ctx, { timezone: t.timezone, platform, settings });
        // parcels back at the sender and never paid: cancel without restock, voiding the payment (behind a setting)
        await autoCancelReturnedToSender(ctx, { platform, settings });
        await scorePendingItems(ctx, { limit: 200, timezone: t.timezone, addressProvider: await resolveAddressProvider(ctx) });
        await distributeUnassigned(ctx, { source: "cron", timezone: t.timezone, limit: 200 });
        if (new Date().getUTCHours() === 2) await recomputeRecipientProfiles(ctx, undefined, t.country);
      });
    }
    return;
  }
  if (job.kind === "subscriptions") {
    // addon.subscriptions (#67): only tenants with the add-on; delta sync of the subscription app (complete pass at night) and churn risk
    const addons = await adminDb().select({ tenantId: schema.tenantAddons.tenantId }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.moduleKey, SUBSCRIPTIONS_ADDON), eq(schema.tenantAddons.isActive, true)));
    const nightly = new Date().getUTCHours() === 3;
    for (const a of addons) {
      const t = await tenantRow(a.tenantId);
      if (!isTenantOperational(t.status)) continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        const provider = await getSubscriptionProviderFor(ctx);
        if (provider) await runSubscriptionSync(ctx, provider, { kind: nightly ? "reconcile" : "delta" });
        await refreshSubscriberRisk(ctx);
      });
    }
    return;
  }
  if (job.kind === "writes") {
    // outbox retries: tenants with writes due (rescheduled after a rate limit or a network error, or left running by a restart)
    const due = await adminDb().selectDistinct({ tenantId: schema.platformWrites.tenantId }).from(schema.platformWrites).where(and(eq(schema.platformWrites.mode, "async"), inArray(schema.platformWrites.status, ["pending", "running"]), lte(schema.platformWrites.nextAttemptAt, new Date())));
    for (const d of due) {
      const tenant = await tenantRow(d.tenantId);
      if (!isTenantOperational(tenant.status)) continue;
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
      if (!isTenantOperational(tenant.status)) continue;
      await withTenant(tenant.id, (tx) => recheckOpenBackorders(sys(tenant.id)(tx)));
    }
    return;
  }
  if (job.kind === "retention") {
    // platform-wide window (HULLWISE_RETENTION_DAYS, default 14): finished history goes, failures stay until resolved
    const days = platformRetentionDays();
    for (const t of await adminDb().select({ id: schema.tenants.id, settings: schema.tenants.settings }).from(schema.tenants)) {
      await withTenant(t.id, (tx) => purgeExpiredPlatformRows(sys(t.id)(tx), { days }));
      // ads volume control (issue #40): daily rows past the tenant's window become months, rare search terms "(other)"
      const settings = parseTenantSettings(t.settings);
      await withTenant(t.id, (tx) => rollupAdEntityMetrics(sys(t.id)(tx), { retentionDays: settings.adsDailyRetentionDays, minImpressions: settings.adsSearchTermMinImpressions }));
    }
    await purgeEmailRows(adminDb(), { days });
    await purgeBillingEvents(adminDb(), { days });
    // #32: audit rows past each plan's window (batched, one job_runs row per tenant), expired export files, old job history
    const audit = await purgeExpiredAudit(adminDb());
    const exports = await purgeExpiredTenantExports(adminDb());
    const jobRuns = await purgeJobRuns(adminDb(), { days });
    const auditDeleted = audit.reduce((n, a) => n + a.deleted, 0);
    return { rows: auditDeleted + exports + jobRuns, summary: { auditDeleted, exportsExpired: exports, jobRunsDeleted: jobRuns } };
  }
  if (job.kind === "emails") {
    // the platform sender's housekeeping (no tenant): events left pending after the 200, queued emails whose job was lost
    await retryEmailEvents(adminDb());
    await sweepLostEmails(adminDb());
    // Stripe webhook events left pending after the 200 (#53) share the 10-minute housekeeping
    await retryBillingEvents(adminDb());
    return;
  }
  if (job.kind === "tasks" || job.kind === "notify" || job.kind === "digest") {
    // tasks (every 10 min): task rules (time-based ones, orders, closing what moved on) and overdue reminders;
    // notify (hourly): critical stock without incoming PO, late to ship, shipment case sweep; digest (daily): opt-in summary email
    const tenants = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, settings: schema.tenants.settings, timezone: schema.tenants.timezone }).from(schema.tenants);
    for (const t of tenants) {
      if (!isTenantOperational(t.status)) continue;
      await withTenant(t.id, async (tx) => {
        const ctx = sys(t.id)(tx);
        const settings = parseTenantSettings(t.settings);
        if (job.kind === "tasks") {
          await sweepTaskRules(ctx);
          await remindOverdueTasks(ctx);
        } else if (job.kind === "notify") {
          // sync delays moved to the watchdog tick (#32)
          await checkCriticalStock(ctx, settings);
          await checkLateToShip(ctx, settings, t.timezone);
          // delivery exceptions and returns to sender missed on import (a mapping changed, a carrier feed) enter their queues
          await syncShipmentCases(ctx);
        } else await sendDigests(ctx);
      });
    }
    return;
  }
  if (job.kind === "billing") {
    // Stripe events left pending or failed first, so the suspension rule sees the latest payments
    await retryBillingEvents(adminDb());
    await issueDueInvoices(adminDb());
    await applySuspensions(adminDb());
    return;
  }
  const rows = await adminDb().select({ tenantId: schema.integrations.tenantId, provider: schema.integrations.provider }).from(schema.integrations).where(and(inArray(schema.integrations.provider, ["shopify", ...AD_PLATFORMS]), inArray(schema.integrations.status, ["connected", "error", "syncing"])));
  const planOf = new Map((await adminDb().select({ id: schema.tenants.id, planKey: schema.tenants.planKey }).from(schema.tenants).where(inArray(schema.tenants.status, [...OPERATIONAL_TENANT_STATUSES]))).map((t) => [t.id, t.planKey]));
  const active = new Set(planOf.keys());
  const window = adsWindow();
  for (const r of rows) {
    if (!active.has(r.tenantId)) continue;
    if (r.provider === "shopify") {
      if (job.kind === "delta") await enqueue("sync.orders", { tenantId: r.tenantId, kind: "delta" } satisfies SyncOrdersJob, { singletonKey: `${r.tenantId}:delta` });
      if (job.kind === "reconcile") {
        await enqueue("sync.orders", { tenantId: r.tenantId, kind: "reconcile" } satisfies SyncOrdersJob, { singletonKey: `${r.tenantId}:reconcile` });
        await enqueue("sync.catalog", { tenantId: r.tenantId, kind: "reconcile" } satisfies SyncCatalogJob, { singletonKey: `${r.tenantId}:catalog:catalog` });
        await enqueue("sync.returns", { tenantId: r.tenantId, kind: "reconcile" } satisfies SyncReturnsJob, { singletonKey: `${r.tenantId}:returns` });
      }
      if (job.kind === "payouts") await enqueue("sync.payouts", { tenantId: r.tenantId } satisfies SyncPayoutsJob, { singletonKey: `${r.tenantId}:payouts` });
      if (job.kind === "retry") {
        const tenant = await tenantRow(r.tenantId);
        await withTenant(tenant.id, async (tx) => {
          const ctx = sys(tenant.id)(tx);
          await retryFailedWebhooks(ctx, await getCommercePlatformFor(ctx, tenant), { country: tenant.country });
        });
      }
    } else if (job.kind === "ads" && isAdPlatform(r.provider) && isAdPlatformInPlan(r.provider, planOf.get(r.tenantId) ?? "")) {
      await enqueue("sync.ads", { tenantId: r.tenantId, provider: r.provider, ...window } satisfies SyncAdsJob, { singletonKey: `${r.tenantId}:${r.provider}:${window.until}` });
    }
  }
}
