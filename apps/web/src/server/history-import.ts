import { withTenant } from "@hullwise/db";
import { historyImportJobs } from "@hullwise/jobs";
import { getCommercePlatformFor, historyImportStatus, planHistoryImport, runHistoryImportSlice, type PlatformTenant } from "@hullwise/services";
import { enqueue } from "@/server/jobs";

export interface HistoryImportStart {
  action: "start" | "resume" | "skip";
  queued: boolean;
  /** Orders imported inline (no worker): the first page of the history. */
  inlineOrders: number | null;
  error: string | null;
}

/**
 * Starts (or resumes) the history import of a store that just connected (#87), from every connect path:
 * the plan decides start / resume / skip (a finished import is never re-run unless `force`, from the
 * console); the jobs go to the worker, deduplicated per tenant. Without a worker (mock/demo) a first
 * slice runs inline and the rest stays paused for the next resync, "Continue import" or worker run.
 * `resumeOnly`: a resync continues a paused import but never starts one.
 */
export async function startHistoryImport(tenant: PlatformTenant, opts: { force?: boolean; resumeOnly?: boolean; actorUserId: string | null }): Promise<HistoryImportStart> {
  const actor = opts.actorUserId ? { type: "user" as const, userId: opts.actorUserId } : { type: "system" as const, userId: null };
  const plan = await withTenant(tenant.id, async (tx) => {
    const s = { tenantId: tenant.id, tx, actor };
    if (opts.resumeOnly) {
      const st = await historyImportStatus(s);
      if (st.state !== "paused" && st.state !== "running" && st.state !== "error") return { action: "skip" as const, parts: [] };
    }
    return planHistoryImport(s, { force: opts.force });
  });
  if (plan.action === "skip") return { action: "skip", queued: false, inlineOrders: null, error: null };
  let queued = plan.parts.length > 0;
  for (const job of historyImportJobs(tenant.id, plan.parts)) queued = (await enqueue(job.queue, job.data, { singletonKey: job.singletonKey })) && queued;
  if (queued) return { action: plan.action, queued: true, inlineOrders: null, error: null };
  const slice = await withTenant(tenant.id, async (tx) => {
    const s = { tenantId: tenant.id, tx, actor };
    return runHistoryImportSlice(s, await getCommercePlatformFor(s, tenant), { country: tenant.country });
  });
  return { action: plan.action, queued: false, inlineOrders: slice.orders, error: slice.error };
}
