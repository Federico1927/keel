import * as Sentry from "@sentry/node";
import { checkRuntimeConfig, SENTRY_DATA_COLLECTION } from "@keel/config";
import { createBoss } from "./boss";
import { handleSyncAds, handleSyncCatalog, handleSyncOrders, handleTick, handleWebhook, type Enqueue } from "./handlers";
import { QUEUES, type SyncAdsJob, type SyncCatalogJob, type SyncOrdersJob, type TickJob, type WebhookJob } from "./queues";

/** Nightly reconciliation at 03:00 and customer predictions and full live-segment refresh at 03:40, live segments every 10 min, pixel stitching and server-side conversions every 5 min, delta every 15 min, ads daily at 06:00, webhook retry every 10 min (UTC). */
const SCHEDULES: { cron: string; data: TickJob }[] = [
  { cron: "*/15 * * * *", data: { kind: "delta" } },
  { cron: "*/10 * * * *", data: { kind: "retry" } },
  { cron: "0 6 * * *", data: { kind: "ads" } },
  { cron: "0 3 * * *", data: { kind: "reconcile" } },
  { cron: "30 4 * * *", data: { kind: "billing" } },
  { cron: "5,15,25,35,45,55 * * * *", data: { kind: "cod" } },
  { cron: "20 * * * *", data: { kind: "alerts" } },
  { cron: "*/10 * * * *", data: { kind: "returns" } },
  { cron: "40 3 * * *", data: { kind: "crm" } },
  { cron: "2,12,22,32,42,52 * * * *", data: { kind: "segments" } },
  { cron: "*/5 * * * *", data: { kind: "tracking" } },
];

/** Same startup rules as the web process; Sentry (errors only, no PII) when `SENTRY_DSN` is set. */
function prepare() {
  const { errors, warnings } = checkRuntimeConfig(process.env, "worker");
  for (const w of warnings) console.warn(`[jobs] config: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[jobs] config: ${e}`);
    console.error("[jobs] refusing to start, fix the variables above.");
    process.exit(1);
  }
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      tracesSampleRate: 0,
      dataCollection: SENTRY_DATA_COLLECTION,
    });
  }
}

async function main() {
  prepare();
  const boss = createBoss();
  boss.on("error", (err: unknown) => {
    console.error("[jobs] boss error", err);
    Sentry.captureException(err);
  });
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q).catch(() => undefined);
  const enqueue: Enqueue = async (queue, data, opts) => {
    await boss.send(queue, data as object, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts?.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 60 } : {}) });
  };
  // A failing job is reported, then rethrown so pg-boss applies its retry policy.
  const one = <T>(fn: (data: T) => Promise<void>) => async (jobs: { data: T }[] | { data: T }) => {
    for (const j of Array.isArray(jobs) ? jobs : [jobs]) {
      try {
        await fn(j.data);
      } catch (err) {
        Sentry.captureException(err, { extra: { job: j.data } });
        throw err;
      }
    }
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
    await Sentry.flush(2_000);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (err) => {
  console.error(err);
  Sentry.captureException(err);
  await Sentry.flush(2_000);
  process.exit(1);
});
