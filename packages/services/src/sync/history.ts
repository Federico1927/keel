import { and, desc, eq, schema, sql } from "@hullwise/db";
import type { ServiceContext } from "../context";

/**
 * The first Shopify import of a store (issue #87): every order created inside the tenant's history
 * window, read by a resumable `sync_runs` row of kind `initial`. Delta syncs only cover the last
 * 30 days on their first run, so until this import is done, RFM, cohorts, past P/L and customer
 * history are incomplete.
 */
export type HistoryImportState = "not_started" | "running" | "paused" | "error" | "done";

export interface HistoryImportStatus {
  state: HistoryImportState;
  runId: string | null;
  /** Orders created or changed by the import so far. */
  ordersImported: number;
  /** Oldest order date the import reads; null when it reads every order or has not started. */
  since: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  /** Oldest order Hullwise holds for the tenant, whatever wrote it. */
  oldestOrderAt: Date | null;
}

export async function historyImportStatus(ctx: ServiceContext, provider = "shopify"): Promise<HistoryImportStatus> {
  const [run] = await ctx.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, "orders"), eq(schema.syncRuns.kind, "initial"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  const [oldest] = await ctx.tx.select({ at: sql<Date | null>`min(${schema.orders.placedAt})` }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenantId));
  const oldestOrderAt = oldest?.at ? new Date(oldest.at) : null;
  if (!run) return { state: "not_started", runId: null, ordersImported: 0, since: null, startedAt: null, finishedAt: null, error: null, oldestOrderAt };
  const createdSince = (run.cursor as { createdSince?: string | null } | null)?.createdSince ?? null;
  const state: HistoryImportState = run.status === "success" ? "done" : run.status === "paused" ? "paused" : run.status === "error" ? "error" : "running";
  return { state, runId: run.id, ordersImported: run.rowsWritten, since: createdSince ? new Date(createdSince) : null, startedAt: run.startedAt, finishedAt: run.status === "success" ? run.finishedAt : null, error: run.status === "error" ? run.error : null, oldestOrderAt };
}

/**
 * Restarts the first import with another window (e.g. a shorter one while testing a big store): the latest
 * initial orders run is rewound to the start of `since` and left paused, so the next step resumes it from
 * there. The same row is reused, never a second run, so a step still running cannot leave two imports
 * side by side: the update waits for its transaction and the following step reads the new cursor. Orders
 * already imported stay. A finished import gets a new paused run with the new window.
 */
export async function restartHistoryImport(ctx: ServiceContext, since: Date | null, provider = "shopify"): Promise<{ runId: string; previousSince: string | null }> {
  const cursor = { nextCursor: null, createdSince: since?.toISOString() ?? null, highWaterMark: null, pages: 0 };
  const [run] = await ctx.tx.select({ id: schema.syncRuns.id, status: schema.syncRuns.status, cursor: schema.syncRuns.cursor }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, "orders"), eq(schema.syncRuns.kind, "initial"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  const previousSince = ((run?.cursor ?? {}) as { createdSince?: string | null }).createdSince ?? null;
  if (run && run.status !== "success") {
    await ctx.tx.update(schema.syncRuns).set({ status: "paused", cursor, error: null, finishedAt: null, rowsWritten: 0, rowsScanned: 0, conflicts: 0 }).where(eq(schema.syncRuns.id, run.id));
    return { runId: run.id, previousSince };
  }
  const [created] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType: "orders", kind: "initial", status: "paused", cursor, startedAt: ctx.now ?? new Date() }).returning({ id: schema.syncRuns.id });
  return { runId: created!.id, previousSince };
}
