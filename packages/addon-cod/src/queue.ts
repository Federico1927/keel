import type { CodSettings } from "./settings";

export type QueueStatus = "pending" | "scheduled" | "unreachable" | "confirm_scheduled" | "confirmed" | "cancelled" | "left";
/** `confirm_scheduled`: the customer agreed to receive the order from a later day; the daily job confirms it then. */
export type AttemptOutcome = "confirmed" | "no_answer" | "call_back" | "cancelled" | "modified" | "confirm_scheduled";
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["confirmed", "no_answer", "call_back", "cancelled", "modified", "confirm_scheduled"];
export const OPEN_QUEUE_STATUSES: readonly QueueStatus[] = ["pending", "scheduled", "unreachable", "confirm_scheduled"];
/** Statuses an operator still has to call (the "to call" list); unreachable and planned confirmations have their own views. */
export const TO_CALL_STATUSES: readonly QueueStatus[] = ["pending", "scheduled"];

/** Explicit outcome machine: the documented one, not the tag-inferred one of the reference. */
export function applyOutcome(current: { status: QueueStatus; noAnswerCount: number }, outcome: AttemptOutcome, settings: Pick<CodSettings, "unreachableAfterAttempts">, callBackAt: Date | null = null): { status: QueueStatus; noAnswerCount: number; callBackAt: Date | null } {
  switch (outcome) {
    case "confirmed":
      return { status: "confirmed", noAnswerCount: current.noAnswerCount, callBackAt: null };
    case "cancelled":
      return { status: "cancelled", noAnswerCount: current.noAnswerCount, callBackAt: null };
    case "call_back":
      return { status: "scheduled", noAnswerCount: current.noAnswerCount, callBackAt };
    case "modified":
      return { status: "pending", noAnswerCount: current.noAnswerCount, callBackAt: null };
    case "confirm_scheduled":
      return { status: "confirm_scheduled", noAnswerCount: current.noAnswerCount, callBackAt: null };
    case "no_answer": {
      const n = current.noAnswerCount + 1;
      return { status: n >= settings.unreachableAfterAttempts ? "unreachable" : "pending", noAnswerCount: n, callBackAt: null };
    }
  }
}

export interface QueueSortable {
  status: QueueStatus;
  callBackAt: Date | null;
  attemptsCount: number;
  enteredAt: Date;
}

/** Priority: overdue call-backs, then items already attempted, then FIFO; future call-backs last. */
export function queuePriority(item: QueueSortable, now: Date): [number, number] {
  if (item.callBackAt && item.callBackAt <= now) return [0, item.callBackAt.getTime()];
  if (item.callBackAt && item.callBackAt > now) return [3, item.callBackAt.getTime()];
  if (item.attemptsCount > 0) return [1, item.enteredAt.getTime()];
  return [2, item.enteredAt.getTime()];
}

export function compareQueue(a: QueueSortable, b: QueueSortable, now: Date): number {
  const [pa, ta] = queuePriority(a, now);
  const [pb, tb] = queuePriority(b, now);
  return pa - pb || ta - tb;
}

/* ---------- aging (C.1, C.2) ---------- */

export type AgingLevel = "fresh" | "warn" | "alert";
export interface AgingThresholds {
  agingWarnHours: number;
  agingAlertHours: number;
}

/**
 * How stale a row is: by the last call when there was one, otherwise by the time in queue (and then
 * `neverContacted` drives the badge). Call-backs not yet due are always fresh.
 */
export function rowAging(item: { lastAttemptAt: Date | null; enteredAt: Date; callBackAt: Date | null }, now: Date, t: AgingThresholds): { level: AgingLevel; hours: number; neverContacted: boolean } {
  if (item.callBackAt && item.callBackAt > now) return { level: "fresh", hours: 0, neverContacted: !item.lastAttemptAt };
  const since = item.lastAttemptAt ?? item.enteredAt;
  const hours = Math.max(0, (now.getTime() - since.getTime()) / 3600e3);
  return { level: hours >= t.agingAlertHours ? "alert" : hours >= t.agingWarnHours ? "warn" : "fresh", hours: Math.floor(hours), neverContacted: !item.lastAttemptAt };
}

/** Count and average age in hours (since entering the queue) of a bucket of items. */
export function bucketStats(items: readonly { enteredAt: Date }[], now: Date): { count: number; avgAgeHours: number | null } {
  if (!items.length) return { count: 0, avgAgeHours: null };
  const total = items.reduce((s, i) => s + Math.max(0, now.getTime() - i.enteredAt.getTime()), 0);
  return { count: items.length, avgAgeHours: Math.round(total / items.length / 3600e3) };
}

/** Splits orders as evenly as possible across operators, oldest first, starting from the least loaded. */
export function splitEvenly<T>(items: readonly T[], operators: readonly { userId: string; load: number }[]): Map<string, T[]> {
  const out = new Map<string, T[]>(operators.map((o) => [o.userId, []]));
  if (!operators.length) return out;
  const load = new Map(operators.map((o) => [o.userId, o.load]));
  for (const item of items) {
    const next = [...load.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    out.get(next)!.push(item);
    load.set(next, load.get(next)! + 1);
  }
  return out;
}
