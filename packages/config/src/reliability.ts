/**
 * Platform reliability (#32): integration watchdog, failure alerts, job history, tenant data export.
 * Plain values so the console, the jobs and the tests read the same numbers.
 */

/** Health of one integration source (`integration_health.status`). */
export const SOURCE_HEALTH_STATUSES = ["ok", "degraded", "error", "stale", "idle", "unknown"] as const;
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];
/** Statuses that count as "not OK" on the dashboard widget and in the watchdog. */
export const SOURCE_PROBLEM_STATUSES = ["degraded", "error", "stale", "idle"] as const satisfies readonly SourceHealthStatus[];
/** Statuses that count as an integration error on the console (idle is a warning, not an error). */
export const SOURCE_ERROR_STATUSES = ["degraded", "error", "stale"] as const satisfies readonly SourceHealthStatus[];

export function isSourceProblem(status: string): boolean {
  return (SOURCE_PROBLEM_STATUSES as readonly string[]).includes(status);
}

/**
 * Sources fed by events rather than by a periodic pull (inbound webhooks, outbound writes): silence
 * there means nothing happened, so they never go stale or idle, only degraded or in error.
 */
export const EVENT_DRIVEN_SOURCE_SUFFIXES = ["webhooks", "writes"] as const;

export function isEventDrivenSource(source: string): boolean {
  const suffix = source.split(":")[1];
  return !!suffix && (EVENT_DRIVEN_SOURCE_SUFFIXES as readonly string[]).includes(suffix);
}

/** Owners and admins hear about one source that is not OK at most this often. */
export const WATCHDOG_NOTIFY_EVERY_HOURS = 6;

/**
 * Successful runs in a row that wrote nothing before a source counts as idle, per provider: a quiet
 * shop's 15-minute delta writes nothing for hours (96 runs = a day), a daily ads pull that writes no
 * metric for three days is suspicious.
 */
export const IDLE_AFTER_ZERO_ROW_RUNS: Readonly<Record<string, number>> = { shopify: 96, meta: 3, google: 3 };
export const DEFAULT_IDLE_AFTER_ZERO_ROW_RUNS = 10;

export function idleAfterRuns(source: string): number {
  return IDLE_AFTER_ZERO_ROW_RUNS[source.split(":")[0] ?? ""] ?? DEFAULT_IDLE_AFTER_ZERO_ROW_RUNS;
}

/** Platform failure alerts: a job type failing this many runs in a row, at most one alert per signature per window. */
export const JOB_FAILURES_BEFORE_ALERT = 3;
export const FAILURE_ALERT_WINDOW_HOURS = 6;

/** Days a tenant data export can be downloaded; then the file is deleted and the link answers "expired". */
export const TENANT_EXPORT_TTL_DAYS = 7;
