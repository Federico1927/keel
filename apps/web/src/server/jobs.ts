import { platformRetentionDays } from "@keel/config";
import { createBoss, QUEUES, queueRetentionOptions, runTrackedJob, type Enqueue, type QueueName } from "@keel/jobs";

/**
 * Enqueue helper for the web process. Queueing is opt-in (`KEEL_JOBS_QUEUE=1`, set when a
 * worker is deployed); otherwise callers run the work inline right after responding, so a
 * single-process demo never leaves webhooks pending. pg-boss is started lazily on first use.
 */
let bossPromise: Promise<Awaited<ReturnType<typeof createBoss>> | null> | null = null;

async function boss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      try {
        const b = createBoss();
        b.on("error", (e: unknown) => console.error("[web] pg-boss", e));
        await b.start();
        for (const q of Object.values(QUEUES)) await b.createQueue(q, queueRetentionOptions(platformRetentionDays())).catch(() => undefined);
        return b;
      } catch (e) {
        console.warn("[web] pg-boss unavailable, jobs run inline:", e instanceof Error ? e.message : e);
        return null;
      }
    })();
  }
  return bossPromise;
}

/** Returns true when the job was queued, false when the caller should run it inline. */
export async function enqueue(queue: QueueName, data: object, opts: { singletonKey?: string; startAfterSeconds?: number } = {}): Promise<boolean> {
  if (process.env.KEEL_JOBS_QUEUE !== "1") return false;
  const b = await boss();
  if (!b) return false;
  try {
    await b.send(queue, data, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 60 } : {}), ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
    return true;
  } catch (e) {
    console.warn("[web] enqueue failed, running inline:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Runs a job in this process when no worker is deployed (call it inside `after()`), recorded in the
 * job history like a worker run (#32); jobs it enqueues run inline too.
 */
export async function runJobInline(queue: QueueName, data: object, requestedBy: string | null): Promise<void> {
  const inline: Enqueue = async (q, d) => {
    await runTrackedJob(q as QueueName, d, inline, { trigger: "inline" }).catch((e: unknown) => console.error(`[web] inline job ${q} failed:`, e instanceof Error ? e.message : e));
  };
  await runTrackedJob(queue, data, inline, { trigger: requestedBy ? "manual" : "inline", requestedBy }).catch((e: unknown) => console.error(`[web] inline job ${queue} failed:`, e instanceof Error ? e.message : e));
}
