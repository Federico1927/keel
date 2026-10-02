import { adminDb } from "@hullwise/db";
import { deliverEmailJob, setEmailDispatcher, type EmailJob } from "@hullwise/services";
import { enqueue } from "./jobs";

const flag = globalThis as typeof globalThis & { __hullwiseEmailDispatcherInstalled?: boolean };
const MAX_MISSING_RETRIES = 5;

/** Without a worker: delivered by this process shortly after the request, retried in process (the row may not be committed yet). */
function deliverLater(job: EmailJob, delayMs: number, missing = 0) {
  setTimeout(() => {
    deliverEmailJob(adminDb(), job)
      .then((r) => {
        if (r.status === "missing" && missing < MAX_MISSING_RETRIES) deliverLater(job, 1_000, missing + 1);
        else if (r.status !== "missing" && r.retryInMs !== undefined) deliverLater(job, Math.min(r.retryInMs, 30 * 60_000), missing);
      })
      .catch((e: unknown) => console.error("[email] delivery failed:", e instanceof Error ? e.message : e));
  }, delayMs).unref?.();
}

/**
 * Email dispatcher of the web process, installed once at startup (instrumentation) and on first
 * import: a pg-boss `email.send` job when the worker is deployed (`HULLWISE_JOBS_QUEUE=1`), otherwise a
 * delivery by this process after the response. Never inside the request.
 */
export function installEmailDispatcher(): void {
  if (flag.__hullwiseEmailDispatcherInstalled) return;
  flag.__hullwiseEmailDispatcherInstalled = true;
  setEmailDispatcher(async (job) => {
    if (await enqueue("email.send", job, { startAfterSeconds: 2 })) return;
    deliverLater(job, 300);
  });
}

installEmailDispatcher();
