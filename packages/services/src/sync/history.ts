import { and, desc, eq, inArray, schema, sql } from "@hullwise/db";
import { parseTenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";

/**
 * Historical import of a newly connected store (issue #87). The work is three resumable `initial` runs
 * (`sync_runs`: orders within the tenant's history window, the full catalog, the returns of the window);
 * the progress lives on the orders run and, durably (successful runs are purged after the retention
 * window), in `integrations.config.historyImport` so a finished import is never re-run by a reconnect.
 */
export type HistoryImportState = "not_started" | "running" | "paused" | "done" | "error";
export type HistoryImportPart = "orders" | "catalog" | "returns";
export const HISTORY_IMPORT_PARTS: HistoryImportPart[] = ["orders", "catalog", "returns"];
/** Prefix of the integration's last error when the history import failed (health page, console). */
export const HISTORY_IMPORT_FAILED_PREFIX = "History import failed: ";

export interface HistoryImportMarker {
  status?: "running" | "paused" | "done" | "error";
  runId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  ordersImported?: number;
  /** First order date read (null = every order). */
  since?: string | null;
  error?: string | null;
}

export interface HistoryImportStatus {
  state: HistoryImportState;
  inProgress: boolean;
  ordersImported: number;
  oldestOrderAt: Date | null;
  /** The window the tenant asked for (0 = all orders) and the date the running import reads from. */
  months: number;
  since: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

/** The tenant's history window from its settings (set in the console's setup checklist). */
export async function historyImportMonths(ctx: ServiceContext): Promise<number> {
  const [t] = await ctx.tx.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  return parseTenantSettings(t?.settings).historyImportMonths;
}

/** First order date an initial import reads, or null for every order. */
export async function historyWindowStart(ctx: ServiceContext, now: Date): Promise<string | null> {
  const months = await historyImportMonths(ctx);
  if (!months) return null;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/** Merges `patch` into `integrations.config.historyImport` of the provider's row. */
export async function writeHistoryMarker(ctx: ServiceContext, provider: string, patch: HistoryImportMarker): Promise<void> {
  await ctx.tx
    .update(schema.integrations)
    .set({ config: sql`coalesce(${schema.integrations.config}, '{}'::jsonb) || jsonb_build_object('historyImport', coalesce(${schema.integrations.config} -> 'historyImport', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)` })
    .where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider)));
}

const objectOf: Record<HistoryImportPart, string> = { orders: "orders", catalog: "catalog", returns: "returns" };
const RUN_STATE: Record<string, HistoryImportState> = { running: "running", paused: "paused", success: "done", error: "error" };

async function latestInitialRuns(ctx: ServiceContext, provider: string) {
  const rows = await ctx.tx.select({ id: schema.syncRuns.id, objectType: schema.syncRuns.objectType, status: schema.syncRuns.status, rowsScanned: schema.syncRuns.rowsScanned, cursor: schema.syncRuns.cursor, error: schema.syncRuns.error, startedAt: schema.syncRuns.startedAt, finishedAt: schema.syncRuns.finishedAt }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.kind, "initial"), inArray(schema.syncRuns.objectType, Object.values(objectOf)))).orderBy(desc(schema.syncRuns.startedAt)).limit(30);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.objectType)) latest.set(r.objectType, r);
  return latest;
}

/** Progress for the integrations page, the setup checklist and the dashboard banner. */
export async function historyImportStatus(ctx: ServiceContext, provider = "shopify"): Promise<HistoryImportStatus> {
  const [row] = await ctx.tx.select({ config: schema.integrations.config, status: schema.integrations.status }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider))).limit(1);
  const marker = ((row?.config as { historyImport?: HistoryImportMarker } | null)?.historyImport ?? {}) as HistoryImportMarker;
  const run = (await latestInitialRuns(ctx, provider)).get("orders");
  const state: HistoryImportState = run ? (RUN_STATE[run.status] ?? "running") : (marker.status ?? "not_started");
  const [oldest] = await ctx.tx.select({ at: sql<string | null>`min(${schema.orders.placedAt})` }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenantId));
  const since = (run?.cursor as { createdSince?: string | null } | undefined)?.createdSince ?? marker.since ?? null;
  // a disconnected store does not keep importing: a paused run is shown as paused, not as in progress
  const connected = !!row && row.status !== "not_connected";
  return {
    state,
    inProgress: connected && (state === "running" || state === "paused"),
    ordersImported: run?.rowsScanned ?? marker.ordersImported ?? 0,
    oldestOrderAt: oldest?.at ? new Date(oldest.at) : null,
    months: await historyImportMonths(ctx),
    since: since ? new Date(since) : null,
    startedAt: run?.startedAt ?? (marker.startedAt ? new Date(marker.startedAt) : null),
    finishedAt: run?.finishedAt ?? (marker.finishedAt ? new Date(marker.finishedAt) : null),
    error: state === "error" ? (run?.error ?? marker.error ?? null) : null,
  };
}

/**
 * What a connect (or the console's "run again") must do about the history import:
 * - never started, or `force` → `start` all three parts;
 * - running or paused (a reconnect mid-way) → `resume` the parts not finished yet, from their cursors;
 * - failed → the failed runs are set back to paused so they resume where they stopped;
 * - finished → `skip` (only the console's `force` runs it again).
 */
export async function planHistoryImport(ctx: ServiceContext, opts: { force?: boolean; provider?: string } = {}): Promise<{ action: "start" | "resume" | "skip"; parts: HistoryImportPart[] }> {
  const provider = opts.provider ?? "shopify";
  const status = await historyImportStatus(ctx, provider);
  if (opts.force || status.state === "not_started") {
    await writeHistoryMarker(ctx, provider, { status: "running", runId: null, startedAt: (ctx.now ?? new Date()).toISOString(), finishedAt: null, ordersImported: 0, error: null });
    return { action: "start", parts: [...HISTORY_IMPORT_PARTS] };
  }
  if (status.state === "done") return { action: "skip", parts: [] };
  const runs = await latestInitialRuns(ctx, provider);
  const parts: HistoryImportPart[] = [];
  for (const part of HISTORY_IMPORT_PARTS) {
    const run = runs.get(objectOf[part]);
    if (run?.status === "success") continue;
    if (run?.status === "error") await ctx.tx.update(schema.syncRuns).set({ status: "paused", error: null, finishedAt: null }).where(eq(schema.syncRuns.id, run.id));
    parts.push(part);
  }
  if (status.state === "error") await writeHistoryMarker(ctx, provider, { status: "paused", error: null });
  return { action: "resume", parts };
}
