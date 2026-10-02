import { appDb } from "@hullwise/db";
import { deliverWebhook, setWebhookDispatcher, type WebhookJob } from "@hullwise/services";
import { enqueue } from "./jobs";

const flag = globalThis as typeof globalThis & { __hullwiseWebhookDispatcherInstalled?: boolean };
const MAX_MISSING_RETRIES = 5;

/** Without a worker: delivered by this process after the response, retried in process on the backoff schedule (#81). */
function deliverLater(job: WebhookJob, delayMs: number, missing = 0) {
  setTimeout(() => {
    deliverWebhook(appDb(), job)
      .then((r) => {
        if (r.status === "missing" && missing < MAX_MISSING_RETRIES) deliverLater(job, 1_000, missing + 1);
        else if (r.status === "retrying") deliverLater(job, r.retryInSeconds * 1000, missing);
      })
      .catch((e: unknown) => console.error("[webhooks] delivery failed:", e instanceof Error ? e.message : e));
  }, delayMs).unref?.();
}

/**
 * Webhook dispatcher of the web process, installed once at startup (instrumentation) and on first
 * import: a pg-boss `webhook.deliver` job when the worker is deployed (`HULLWISE_JOBS_QUEUE=1`),
 * otherwise a delivery by this process shortly after the request. Never inside the request.
 */
export function installWebhookDispatcher(): void {
  if (flag.__hullwiseWebhookDispatcherInstalled) return;
  flag.__hullwiseWebhookDispatcherInstalled = true;
  setWebhookDispatcher(async (job) => {
    if (await enqueue("webhook.deliver", job, { startAfterSeconds: 2, singletonKey: `${job.deliveryId}:0` })) return;
    deliverLater(job, 500);
  });
}

installWebhookDispatcher();
