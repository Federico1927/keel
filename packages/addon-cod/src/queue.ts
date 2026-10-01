import type { CodSettings } from "./settings";

export type QueueStatus = "pending" | "scheduled" | "unreachable" | "confirmed" | "cancelled" | "left";
export type AttemptOutcome = "confirmed" | "no_answer" | "call_back" | "cancelled" | "modified";
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["confirmed", "no_answer", "call_back", "cancelled", "modified"];
export const OPEN_QUEUE_STATUSES: readonly QueueStatus[] = ["pending", "scheduled", "unreachable"];

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
