import { QUEUES, jobTenantOf, jobTypeOf, type QueueName } from "./queues";

/** Queues whose successful runs are worth a log line: imports, syncs and writes to the store. */
export const LOGGED_QUEUES = new Set<QueueName>([QUEUES.syncOrders, QUEUES.syncCatalog, QUEUES.syncAds, QUEUES.syncPayouts, QUEUES.syncReturns, QUEUES.syncAnalytics, QUEUES.platformWrite, QUEUES.tenantExport]);

/** One line per job: queue, type, tenant, duration and a short outcome (counts or the error message; never the payload). */
export function jobLogLine(outcome: "done" | "failed", queue: QueueName, data: unknown, started: number, detail: string): string {
  const tenant = jobTenantOf(data);
  return `[jobs] ${outcome} ${queue} type=${jobTypeOf(queue, data)}${tenant ? ` tenant=${tenant}` : ""} ${((Date.now() - started) / 1000).toFixed(1)}s${detail ? ` ${detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
}

/** Numbers, flags and identifier-like strings of a handler's result (no free text, so no personal data) (`{ imported: 250, cursor: "…" }` → `imported=250 cursor=…`). */
export function summarize(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  return Object.entries(result as Record<string, unknown>).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && /^[\w:.-]{1,40}$/.test(v))).map(([k, v]) => `${k}=${String(v)}`).join(" ");
}
