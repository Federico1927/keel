import * as Sentry from "@sentry/node";
import { checkRuntimeConfig, platformRetentionDays, SENTRY_DATA_COLLECTION } from "@hullwise/config";
import { setEmailDispatcher, setWebhookDispatcher } from "@hullwise/services";
import { createBoss } from "./boss";
import { runTrackedJob } from "./dispatch";
import { LOGGED_QUEUES, jobLogLine, summarize } from "./job-log";
import type { Enqueue } from "./handlers";
import { QUEUES, queueRetentionOptions, type QueueName } from "./queues";
import { installSchedules } from "./schedules";


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
    const id = await boss.send(queue, data as object, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts?.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: opts.continuation ? 1 : 60 } : {}), ...(opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
    // pg-boss answers null when the dedupe slot already holds a job: say so, a dropped continuation stops an import
    if (!id && opts?.singletonKey) console.warn(`[jobs] not queued (same key in its slot): ${queue} ${opts.singletonKey}${opts.continuation ? " (continuation)" : ""}`);
  };
  // emails queued by ticks (digests, alerts, notifications) go through the same queue; a short delay lets their transaction commit
  setEmailDispatcher((job) => enqueue(QUEUES.emailSend, job, { startAfterSeconds: 2 }));
  // outgoing webhooks emitted by jobs (order imports, stock syncs): same short delay for the emitting transaction to commit
  setWebhookDispatcher((job) => enqueue(QUEUES.webhookDeliver, job, { startAfterSeconds: 2, singletonKey: `${job.deliveryId}:0` }));
  // Every job is recorded in job_runs (#32); a failing one is reported, then rethrown so pg-boss applies its retry policy.
  const one = (queue: QueueName) => async (jobs: { data: unknown }[] | { data: unknown }) => {
    for (const j of Array.isArray(jobs) ? jobs : [jobs]) {
      const started = Date.now();
      try {
        const result = await runTrackedJob(queue, j.data, enqueue);
        if (LOGGED_QUEUES.has(queue)) console.info(jobLogLine("done", queue, j.data, started, summarize(result)));
      } catch (err) {
        // without SENTRY_DSN this line is the only trace of a failure (pg-boss retries silently)
        console.error(jobLogLine("failed", queue, j.data, started, err instanceof Error ? err.message : String(err)));
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
  await boss.work(QUEUES.syncAnalytics, one(QUEUES.syncAnalytics));
  await boss.work(QUEUES.tick, one(QUEUES.tick));
  await boss.work(QUEUES.listExport, one(QUEUES.listExport));
  await boss.work(QUEUES.emailSend, { batchSize: 5 }, one(QUEUES.emailSend));
  await boss.work(QUEUES.emailEvent, { batchSize: 10 }, one(QUEUES.emailEvent));
  await boss.work(QUEUES.tenantExport, one(QUEUES.tenantExport));
  await boss.work(QUEUES.tenantDelete, one(QUEUES.tenantDelete));
  await boss.work(QUEUES.billingEvent, one(QUEUES.billingEvent));
  await boss.work(QUEUES.campaignSend, { batchSize: 2 }, one(QUEUES.campaignSend));
  await boss.work(QUEUES.webhookDeliver, { batchSize: 5 }, one(QUEUES.webhookDeliver));
  const schedules = await installSchedules(boss);
  if (schedules.removed.length) console.info(`[jobs] removed stale schedules: ${schedules.removed.join(", ")}`);
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
