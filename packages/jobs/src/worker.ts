import * as Sentry from "@sentry/node";
import { checkRuntimeConfig, platformRetentionDays, SENTRY_DATA_COLLECTION } from "@hullwise/config";
import { setEmailDispatcher } from "@hullwise/services";
import { createBoss } from "./boss";
import { runTrackedJob } from "./dispatch";
import type { Enqueue } from "./handlers";
import { QUEUES, queueRetentionOptions, type QueueName, type TickJob } from "./queues";

/** Nightly reconciliation at 03:00 and customer predictions and full live-segment refresh at 03:40, live segments every 10 min, pixel stitching and server-side conversions every 5 min, delta every 15 min, ads daily at 06:00, webhook retry every 10 min, platform-write retries every minute, retention daily at 04:10, backorder safety re-check and email housekeeping every 10 min, payouts daily at 05:20, integration watchdog every 10 min, customer campaigns every minute (UTC). */
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
  { cron: "* * * * *", data: { kind: "writes" } },
  { cron: "10 4 * * *", data: { kind: "retention" } },
  { cron: "4,14,24,34,44,54 * * * *", data: { kind: "tasks" } },
  { cron: "25 * * * *", data: { kind: "notify" } },
  { cron: "5 7 * * *", data: { kind: "digest" } },
  { cron: "7,17,27,37,47,57 * * * *", data: { kind: "backorders" } },
  { cron: "3,13,23,33,43,53 * * * *", data: { kind: "emails" } },
  { cron: "20 5 * * *", data: { kind: "payouts" } },
  { cron: "1,11,21,31,41,51 * * * *", data: { kind: "watchdog" } },
  { cron: "* * * * *", data: { kind: "campaigns" } },
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
  const retention = queueRetentionOptions(platformRetentionDays());
  for (const q of Object.values(QUEUES)) {
    await boss.createQueue(q, retention).catch(() => undefined);
    await boss.updateQueue(q, retention).catch(() => undefined);
  }
  const enqueue: Enqueue = async (queue, data, opts) => {
    await boss.send(queue, data as object, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts?.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 60 } : {}), ...(opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
  };
  // emails queued by ticks (digests, alerts, notifications) go through the same queue; a short delay lets their transaction commit
  setEmailDispatcher((job) => enqueue(QUEUES.emailSend, job, { startAfterSeconds: 2 }));
  // Every job is recorded in job_runs (#32); a failing one is reported, then rethrown so pg-boss applies its retry policy.
  const one = (queue: QueueName) => async (jobs: { data: unknown }[] | { data: unknown }) => {
    for (const j of Array.isArray(jobs) ? jobs : [jobs]) {
      try {
        await runTrackedJob(queue, j.data, enqueue);
      } catch (err) {
        Sentry.captureException(err, { extra: { job: j.data } });
        throw err;
      }
    }
  };
  await boss.work(QUEUES.webhookProcess, { batchSize: 5 }, one(QUEUES.webhookProcess));
  await boss.work(QUEUES.syncOrders, one(QUEUES.syncOrders));
  await boss.work(QUEUES.syncCatalog, one(QUEUES.syncCatalog));
  await boss.work(QUEUES.platformWrite, { batchSize: 5 }, one(QUEUES.platformWrite));
  await boss.work(QUEUES.syncAds, one(QUEUES.syncAds));
  await boss.work(QUEUES.syncPayouts, one(QUEUES.syncPayouts));
  await boss.work(QUEUES.syncReturns, one(QUEUES.syncReturns));
  await boss.work(QUEUES.tick, one(QUEUES.tick));
  await boss.work(QUEUES.listExport, one(QUEUES.listExport));
  await boss.work(QUEUES.emailSend, { batchSize: 5 }, one(QUEUES.emailSend));
  await boss.work(QUEUES.emailEvent, { batchSize: 10 }, one(QUEUES.emailEvent));
  await boss.work(QUEUES.tenantExport, one(QUEUES.tenantExport));
  await boss.work(QUEUES.billingEvent, one(QUEUES.billingEvent));
  await boss.work(QUEUES.campaignSend, { batchSize: 2 }, one(QUEUES.campaignSend));
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
