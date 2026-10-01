/** Queue names and payloads; the web app enqueues, the worker consumes. */
export const QUEUES = {
  webhookProcess: "webhook.process",
  syncOrders: "sync.orders",
  syncCatalog: "sync.catalog",
  syncAds: "sync.ads",
  tick: "scheduler.tick",
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
}
export interface SyncAdsJob {
  tenantId: string;
  provider: "meta" | "google";
  since: string;
  until: string;
}
export interface TickJob {
  /** delta (every 15 min) | ads (daily) | reconcile (nightly) | retry (every 10 min) | billing (daily) */
  kind: "delta" | "ads" | "reconcile" | "retry" | "billing" | "cod";
}

/** Yesterday → today as ISO dates, the window a daily ads pull refreshes (platforms restate recent days). */
export function adsWindow(now = new Date(), lookbackDays = 3): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - lookbackDays * 864e5).toISOString().slice(0, 10);
  return { since, until };
}
