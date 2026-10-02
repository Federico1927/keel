import { isAdPlatform, type AdPlatform } from "@hullwise/config";
/** Queue names and payloads; the web app enqueues, the worker consumes. */
export const QUEUES = {
  webhookProcess: "webhook.process",
  syncOrders: "sync.orders",
  syncCatalog: "sync.catalog",
  syncAds: "sync.ads",
  syncPayouts: "sync.payouts",
  syncReturns: "sync.returns",
  platformWrite: "platform.write",
  tick: "scheduler.tick",
  listExport: "list.export",
  emailSend: "email.send",
  emailEvent: "email.event",
  billingEvent: "billing.event",
  tenantExport: "tenant.export",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface WebhookJob {
  tenantId: string;
  eventId: string;
}
export interface SyncOrdersJob {
  tenantId: string;
  kind: "initial" | "delta" | "reconcile";
}
export interface SyncCatalogJob {
  tenantId: string;
  /** delta (resync) | reconcile (nightly) | manual (inventory "Sync now"); default delta. */
  kind?: "delta" | "reconcile" | "manual";
  scope?: "catalog" | "inventory";
}
/** One outbox row of `platform_writes` to execute. */
export interface PlatformWriteJob {
  tenantId: string;
  writeId: string;
}
/** Payouts and balance transactions of the payment processor (actual fees), resumable like the other syncs. */
export interface SyncPayoutsJob {
  tenantId: string;
}
/** Returns created or changed on the platform (nightly reconcile), resumable like the other syncs. */
export interface SyncReturnsJob {
  tenantId: string;
  kind?: "delta" | "reconcile";
}
export interface SyncAdsJob {
  tenantId: string;
  provider: AdPlatform;
  since: string;
  until: string;
  /** "entities": the campaign pull is done, resume the levels below the campaign (issue #40). */
  phase?: "campaigns" | "entities";
  /** "backfill": the first import after connecting (e.g. TikTok's 90 days), resumed as its own run. */
  kind?: "delta" | "backfill";
}
/** A CSV export too large for a direct download (packages/services `requestListExport`). */
export interface ListExportJob {
  tenantId: string;
  exportId: string;
}
/** One queued email (packages/services `queueEmail`): the log row id and the encrypted rendered message. */
export interface EmailSendJob {
  messageId: string;
  payload: string;
}
/** One stored provider delivery event (`email_events`) to apply. */
export interface EmailEventJob {
  eventId: string;
}
/** One stored Stripe webhook event (`billing_events`) to apply (#53). */
export interface BillingEventJob {
  eventId: string;
}
/** A full data export of one tenant (packages/services `requestTenantExport`). */
export interface TenantExportJob {
  tenantId: string;
  exportId: string;
}
export const TICK_KINDS = ["delta", "ads", "reconcile", "retry", "billing", "cod", "alerts", "returns", "crm", "segments", "tracking", "tasks", "notify", "digest", "writes", "retention", "backorders", "emails", "payouts", "watchdog"] as const;
export interface TickJob {
  /** delta (every 15 min) | ads (daily) | reconcile (nightly) | retry (every 10 min) | billing (daily) | writes (every minute: outbox retries) | retention (daily: platform rows, audit retention, expired exports, job history) | backorders (every 10 min: safety re-check) | emails (every 10 min: provider events left behind, lost queued emails) | payouts (daily: processor payouts and actual fees) | watchdog (every 10 min: stale and idle integration sources) */
  kind: (typeof TICK_KINDS)[number];
}

/** One enqueue request (queue, payload, dedup key), as handlers and the console build them. */
export interface QueuedJob {
  queue: QueueName;
  data: object;
  singletonKey?: string;
}

/** The job type recorded in `job_runs`: the queue, or `tick:<kind>` for scheduler ticks. */
export function jobTypeOf(queue: string, data: unknown): string {
  if (queue === QUEUES.tick) return `tick:${(data as Partial<TickJob> | null)?.kind ?? "unknown"}`;
  if (queue === QUEUES.syncAds) return `${queue}:${(data as Partial<SyncAdsJob> | null)?.provider ?? "unknown"}`;
  return queue;
}

/** The tenant a job belongs to, when its payload carries one. */
export function jobTenantOf(data: unknown): string | null {
  const t = (data as { tenantId?: unknown } | null)?.tenantId;
  return typeof t === "string" ? t : null;
}

/**
 * The resync for one stale integration source (watchdog, #32): the pull that refreshes it.
 * Event-driven sources (webhooks, writes) never go stale, so they map to nothing.
 */
export function resyncJobsFor(tenantId: string, source: string, now = new Date()): QueuedJob[] {
  const [provider, part] = source.split(":");
  if (isAdPlatform(provider)) {
    const w = adsWindow(now);
    return [{ queue: QUEUES.syncAds, data: { tenantId, provider, ...w } satisfies SyncAdsJob, singletonKey: `${tenantId}:${provider}:${w.until}` }];
  }
  if (provider !== "shopify") return [];
  if (!part) return [{ queue: QUEUES.syncOrders, data: { tenantId, kind: "delta" } satisfies SyncOrdersJob, singletonKey: `${tenantId}:delta` }];
  if (part === "inventory") return [{ queue: QUEUES.syncCatalog, data: { tenantId, kind: "manual", scope: "inventory" } satisfies SyncCatalogJob, singletonKey: `${tenantId}:catalog:inventory` }];
  if (part === "returns") return [{ queue: QUEUES.syncReturns, data: { tenantId, kind: "delta" } satisfies SyncReturnsJob, singletonKey: `${tenantId}:returns` }];
  if (part === "payouts") return [{ queue: QUEUES.syncPayouts, data: { tenantId } satisfies SyncPayoutsJob, singletonKey: `${tenantId}:payouts` }];
  if (part === "catalog" || part === "products" || part === "discounts") return [{ queue: QUEUES.syncCatalog, data: { tenantId, kind: "delta" } satisfies SyncCatalogJob, singletonKey: `${tenantId}:catalog:catalog` }];
  return [];
}

/**
 * "Run now" from the console (#32): a scheduler tick (platform-wide) or a tenant's pull, by job type
 * as `job_runs` records it. Anything else (webhooks, writes, emails, exports) is not re-runnable by hand.
 */
export function runNowJob(jobType: string, tenantId: string | null, now = new Date()): QueuedJob | null {
  if (jobType.startsWith("tick:")) {
    const kind = jobType.slice(5);
    return (TICK_KINDS as readonly string[]).includes(kind) ? { queue: QUEUES.tick, data: { kind } as TickJob } : null;
  }
  if (!tenantId) return null;
  const source = jobType === QUEUES.syncOrders ? "shopify" : jobType === QUEUES.syncCatalog ? "shopify:catalog" : jobType === QUEUES.syncReturns ? "shopify:returns" : jobType === QUEUES.syncPayouts ? "shopify:payouts" : jobType.startsWith(`${QUEUES.syncAds}:`) ? jobType.slice(QUEUES.syncAds.length + 1) : null;
  return source ? (resyncJobsFor(tenantId, source, now)[0] ?? null) : null;
}

/** pg-boss keeps finished jobs for the same platform retention window as webhooks and writes. */
export function queueRetentionOptions(days: number): { deleteAfterSeconds: number } {
  return { deleteAfterSeconds: days * 86_400 };
}

/** Yesterday → today as ISO dates, the window a daily ads pull refreshes (platforms restate recent days). */
export function adsWindow(now = new Date(), lookbackDays = 3): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - lookbackDays * 864e5).toISOString().slice(0, 10);
  return { since, until };
}
