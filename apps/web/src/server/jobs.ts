import { platformRetentionDays } from "@keel/config";
import { createBoss, QUEUES, queueRetentionOptions, type QueueName } from "@keel/jobs";

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
export async function enqueue(queue: QueueName, data: object, opts: { singletonKey?: string } = {}): Promise<boolean> {
  if (process.env.KEEL_JOBS_QUEUE !== "1") return false;
  const b = await boss();
  if (!b) return false;
  try {
    await b.send(queue, data, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...(opts.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 60 } : {}) });
    return true;
  } catch (e) {
    console.warn("[web] enqueue failed, running inline:", e instanceof Error ? e.message : e);
    return false;
  }
}
