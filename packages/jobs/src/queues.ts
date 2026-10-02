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
  provider: "meta" | "google";
  since: string;
  until: string;
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
export interface TickJob {
  /** delta (every 15 min) | ads (daily) | reconcile (nightly) | retry (every 10 min) | billing (daily) | writes (every minute: outbox retries) | retention (daily) | backorders (every 10 min: safety re-check) | emails (every 10 min: provider events left behind, lost queued emails) | payouts (daily: processor payouts and actual fees) */
  kind: "delta" | "ads" | "reconcile" | "retry" | "billing" | "cod" | "alerts" | "returns" | "crm" | "segments" | "tracking" | "tasks" | "notify" | "digest" | "writes" | "retention" | "backorders" | "emails" | "payouts";
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
