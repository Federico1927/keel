import { randomUUID } from "node:crypto";
import { IntegrationError } from "@hullwise/integrations";

/** Outcome of one record in a bulk action. */
export type BatchItemStatus = "done" | "skipped" | "failed";
export interface BatchItemOutcome {
  id: string;
  /** Human label of the record (order name, product title, return number) for the summary. */
  label: string | null;
  status: BatchItemStatus;
  /** Skip reason code (`already_cancelled`, `bad_transition`, …) or the error of a failure. */
  reason: string | null;
  /** Something worth showing even though the item is done (e.g. the platform write-back failed). */
  note?: string | null;
}
export interface BatchSummary {
  batchId: string;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  items: BatchItemOutcome[];
}

/** Thrown by a worker to skip a record with a reason (not an error: nothing was attempted). */
export class SkipItem extends Error {
  constructor(public readonly reason: string, public readonly label: string | null = null) {
    super(reason);
    this.name = "SkipItem";
  }
}

export type BatchWorkerResult = { label?: string | null; note?: string | null } | void;

/** Readable reason of a failure: integration errors keep their code so the summary can group them. */
export function failureReason(e: unknown): string {
  if (e instanceof IntegrationError) return `${e.code}: ${e.message}`.slice(0, 300);
  if (e instanceof Error) return (e.message || e.name).slice(0, 300);
  return String(e).slice(0, 300);
}

export function newBatchId(): string {
  return randomUUID();
}

/**
 * Runs `worker` once per item with at most `concurrency` items in flight, and collects one outcome
 * per item in input order. A worker returns (done), throws `SkipItem` (skipped with a reason) or
 * throws anything else (failed with the error). One failure never stops the others.
 */
export async function runBatch<T extends { id: string; label?: string | null }>(items: readonly T[], worker: (item: T) => Promise<BatchWorkerResult>, opts: { concurrency: number; batchId?: string }): Promise<BatchSummary> {
  const batchId = opts.batchId ?? newBatchId();
  const outcomes: BatchItemOutcome[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      try {
        const r = await worker(item);
        outcomes[i] = { id: item.id, label: (r && r.label) ?? item.label ?? null, status: "done", reason: null, ...(r && r.note ? { note: r.note } : {}) };
      } catch (e) {
        if (e instanceof SkipItem) outcomes[i] = { id: item.id, label: e.label ?? item.label ?? null, status: "skipped", reason: e.reason };
        else outcomes[i] = { id: item.id, label: item.label ?? null, status: "failed", reason: failureReason(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, items.length)) }, lane));
  return { batchId, total: items.length, done: outcomes.filter((o) => o.status === "done").length, skipped: outcomes.filter((o) => o.status === "skipped").length, failed: outcomes.filter((o) => o.status === "failed").length, items: outcomes };
}
