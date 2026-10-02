import { adminDb } from "@hullwise/db";
import { trackJobRun, type JobTrigger } from "@hullwise/services";
import { handleCampaignSend, handleEmailEvent, handleEmailSend, handleListExport, handlePlatformWrite, handleSyncAds, handleSyncAnalytics, handleSyncCatalog, handleSyncOrders, handleSyncPayouts, handleSyncReturns, handleTenantExport, handleTick, handleWebhook, handleWebhookDeliver, type Enqueue } from "./handlers";
import { QUEUES, jobTenantOf, jobTypeOf, type CampaignSendJob, type EmailEventJob, type EmailSendJob, type ListExportJob, type PlatformWriteJob, type QueueName, type SyncAdsJob, type SyncAnalyticsJob, type SyncCatalogJob, type SyncOrdersJob, type SyncPayoutsJob, type SyncReturnsJob, type TenantExportJob, type TickJob, type WebhookDeliverJob, type WebhookJob } from "./queues";

/** Queue → handler: the single routing table of the worker and of inline runs from the web ("run now" without a worker). */
export async function runJob(queue: QueueName, data: unknown, enqueue: Enqueue): Promise<unknown> {
  switch (queue) {
    case QUEUES.webhookProcess: return handleWebhook(data as WebhookJob);
    case QUEUES.syncOrders: return handleSyncOrders(data as SyncOrdersJob, enqueue);
    case QUEUES.syncCatalog: return handleSyncCatalog(data as SyncCatalogJob, enqueue);
    case QUEUES.syncAds: return handleSyncAds(data as SyncAdsJob, enqueue);
    case QUEUES.syncPayouts: return handleSyncPayouts(data as SyncPayoutsJob, enqueue);
    case QUEUES.syncReturns: return handleSyncReturns(data as SyncReturnsJob, enqueue);
    case QUEUES.syncAnalytics: return handleSyncAnalytics(data as SyncAnalyticsJob, enqueue);
    case QUEUES.platformWrite: return handlePlatformWrite(data as PlatformWriteJob);
    case QUEUES.tick: return handleTick(data as TickJob, enqueue);
    case QUEUES.listExport: return handleListExport(data as ListExportJob);
    case QUEUES.emailSend: return handleEmailSend(data as EmailSendJob, enqueue);
    case QUEUES.emailEvent: return handleEmailEvent(data as EmailEventJob);
    case QUEUES.tenantExport: return handleTenantExport(data as TenantExportJob);
    case QUEUES.campaignSend: return handleCampaignSend(data as CampaignSendJob);
    case QUEUES.webhookDeliver: return handleWebhookDeliver(data as WebhookDeliverJob, enqueue);
  }
}

/**
 * One job, recorded in `job_runs` (#32): status, duration, rows, error; repeated failures raise a
 * platform alert. Errors are rethrown so pg-boss keeps its retry policy.
 */
export function runTrackedJob(queue: QueueName, data: unknown, enqueue: Enqueue, meta: { trigger?: JobTrigger; requestedBy?: string | null } = {}): Promise<unknown> {
  // "run now" from the console puts the super-admin in the payload, so a worker run records it too
  const fromPayload = (data as { requestedBy?: unknown } | null)?.requestedBy;
  const requestedBy = meta.requestedBy ?? (typeof fromPayload === "string" ? fromPayload : null);
  const trigger = meta.trigger ?? (requestedBy ? "manual" : queue === QUEUES.tick ? "schedule" : "queue");
  return trackJobRun(adminDb(), { queue, jobType: jobTypeOf(queue, data), tenantId: jobTenantOf(data), trigger, requestedBy }, () => runJob(queue, data, enqueue));
}
