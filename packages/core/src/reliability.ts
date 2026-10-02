import { idleAfterRuns, isEventDrivenSource, type SourceHealthStatus } from "@hullwise/config";
import { isSyncDelayed } from "./notifications";

/**
 * Pure rules of the platform reliability layer (#32): the status of an integration source as the
 * watchdog sees it, the signature and window of a failure alert, the audit retention cutoff.
 */

export interface IntegrationSourceState {
  source: string;
  lastSuccessAt: Date | null;
  /** When the integration was connected: a source that never succeeded is late from then. */
  connectedAt: Date | null;
  freshnessMinutes: number;
  consecutiveFailures: number;
  /** Successful runs in a row that wrote no rows. */
  zeroRowRuns: number;
}

/** Stale = no success within the freshness window (no grace: the grace only delays the notification). Event-driven sources never go stale. */
export function sourceStaleness(s: IntegrationSourceState, now: Date): { stale: boolean; minutesLate: number } {
  if (isEventDrivenSource(s.source)) return { stale: false, minutesLate: 0 };
  const r = isSyncDelayed({ lastSuccessAt: s.lastSuccessAt, connectedAt: s.connectedAt, freshnessMinutes: s.freshnessMinutes, graceMinutes: 0, now });
  return { stale: r.delayed, minutesLate: r.minutesLate };
}

/**
 * The visible status of a source, by precedence: stale (nothing fresh, whatever the reason) → error
 * (3+ failed attempts in a row) → degraded (a recent failure) → idle (runs succeed but write nothing
 * for N runs, N per provider) → ok; a source that never ran is unknown.
 */
export function sourceStatus(s: IntegrationSourceState, now: Date): SourceHealthStatus {
  if (sourceStaleness(s, now).stale) return "stale";
  if (s.consecutiveFailures >= 3) return "error";
  if (s.consecutiveFailures > 0) return "degraded";
  if (!isEventDrivenSource(s.source) && s.zeroRowRuns >= idleAfterRuns(s.source)) return "idle";
  return s.lastSuccessAt ? "ok" : "unknown";
}

/** Zero-row streak after one run: only a successful run with a known row count moves it. */
export function nextZeroRowRuns(prev: number, ok: boolean, rowsWritten: number | undefined): number {
  if (!ok || rowsWritten === undefined) return prev;
  return rowsWritten === 0 ? prev + 1 : 0;
}

/** True when the last notification is older than the window (or there was none). */
export function windowElapsed(lastAt: Date | null | undefined, windowMinutes: number, now: Date): boolean {
  return !lastAt || now.getTime() - lastAt.getTime() >= windowMinutes * 60_000;
}

export type FailureAlertKind = "job_failure" | "sync_stale";

/** One alert per (kind, tenant, job type or source): repeated failures update it instead of opening new ones. */
export function failureAlertSignature(kind: FailureAlertKind, tenantId: string | null, subject: string): string {
  return `${kind}:${tenantId ?? "platform"}:${subject}`;
}

/** The newest `n` runs (newest first) all failed. */
export function failedInARow(statusesNewestFirst: readonly string[], n: number): boolean {
  return n > 0 && statusesNewestFirst.length >= n && statusesNewestFirst.slice(0, n).every((s) => s === "failed");
}

/** Audit rows created before this instant are past the retention window. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - Math.max(1, days) * 864e5);
}
