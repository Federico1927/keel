import { createBoss } from "./boss";
import { handleSyncAds, handleSyncCatalog, handleSyncOrders, handleTick, handleWebhook, type Enqueue } from "./handlers";
import { QUEUES, type SyncAdsJob, type SyncCatalogJob, type SyncOrdersJob, type TickJob, type WebhookJob } from "./queues";

/** Nightly reconciliation at 03:00, delta every 15 min, ads daily at 06:00, webhook retry every 10 min (UTC). */
const SCHEDULES: { cron: string; data: TickJob }[] = [
  { cron: "*/15 * * * *", data: { kind: "delta" } },
  { cron: "*/10 * * * *", data: { kind: "retry" } },
  { cron: "0 6 * * *", data: { kind: "ads" } },
  { cron: "0 3 * * *", data: { kind: "reconcile" } },
  { cron: "30 4 * * *", data: { kind: "billing" } },
];

async function main() {
  const boss = createBoss();
  boss.on("error", (err: unknown) => console.error("[jobs] boss error", err));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q).catch(() => undefined);
  const enqueue: Enqueue = async (queue, data, opts) => {
    await boss.send(queue, data as object, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts?.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 60 } : {}) });
  };
  const one = <T>(fn: (data: T) => Promise<void>) => async (jobs: { data: T }[] | { data: T }) => {
    for (const j of Array.isArray(jobs) ? jobs : [jobs]) await fn(j.data);
  };
  await boss.work<WebhookJob>(QUEUES.webhookProcess, { batchSize: 5 }, one((d: WebhookJob) => handleWebhook(d)));
  await boss.work<SyncOrdersJob>(QUEUES.syncOrders, one((d: SyncOrdersJob) => handleSyncOrders(d, enqueue)));
  await boss.work<SyncCatalogJob>(QUEUES.syncCatalog, one((d: SyncCatalogJob) => handleSyncCatalog(d)));
  await boss.work<SyncAdsJob>(QUEUES.syncAds, one((d: SyncAdsJob) => handleSyncAds(d)));
  await boss.work<TickJob>(QUEUES.tick, one((d: TickJob) => handleTick(d, enqueue)));
  for (const s of SCHEDULES) await boss.schedule(QUEUES.tick, s.cron, s.data, { singletonKey: s.data.kind });
  console.info("[jobs] worker started: queues", Object.values(QUEUES).join(", "));
  const shutdown = async () => {
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
