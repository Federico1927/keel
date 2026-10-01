import { SHIPMENT_FINAL_STATUSES, type ShipmentStatus } from "./domain";

export interface SourceState {
  source: string;
  status: ShipmentStatus;
  lastEventAt: Date;
}
export interface PrecedenceEntry {
  source: string;
  /** Hours during which this source's data is considered fresh enough to win. */
  freshnessHours: number;
  /** Lower wins when both are fresh. */
  priority: number;
}
export interface ResolveInput {
  states: readonly SourceState[];
  previousStatus: ShipmentStatus | null;
  exceptionReason: string | null;
  exceptionSince: Date | null;
  precedence: readonly PrecedenceEntry[];
  stickyExceptionDays: number;
  now?: Date;
}
export interface ResolveResult {
  status: ShipmentStatus;
  sourceOfTruth: string | null;
  exceptionReason: string | null;
  exceptionSince: Date | null;
  conflicts: { winner: string; loser: string; winnerStatus: ShipmentStatus; loserStatus: ShipmentStatus }[];
}

const REAL_EXCEPTION_REASONS = new Set(["delivery_error", "invalid_order", "source_exception"]);
const EXCEPTION_LIKE: ShipmentStatus[] = ["exception", "attempted"];

/** Default precedence when a tenant has not configured one: the platform is the only source. */
export const DEFAULT_PRECEDENCE: PrecedenceEntry[] = [
  { source: "carrier", freshnessHours: 24, priority: 1 },
  { source: "aggregator", freshnessHours: 24, priority: 2 },
  { source: "warehouse", freshnessHours: 72, priority: 3 },
  { source: "shopify", freshnessHours: 24 * 365, priority: 4 },
];

/**
 * Multi-source status resolution (pattern from the reference platform, generalised):
 * 1. a final status from any source beats everything else;
 * 2. among non-final states, the highest-priority source that is still fresh wins, else the freshest;
 * 3. exceptions are sticky against a regression to in_transit while young and real;
 * 4. delivered/returned/failed are never demoted by a later non-final event.
 */
export function resolveShipmentStatus(input: ResolveInput): ResolveResult {
  const now = input.now ?? new Date();
  const prec = new Map(input.precedence.map((p) => [p.source, p]));
  const states = [...input.states];
  const conflicts: ResolveResult["conflicts"] = [];
  if (states.length === 0) return { status: input.previousStatus ?? "pending", sourceOfTruth: null, exceptionReason: null, exceptionSince: null, conflicts };

  const finals = states.filter((s) => SHIPMENT_FINAL_STATUSES.includes(s.status));
  let winner: SourceState;
  if (finals.length) {
    // Latest final event wins (delivered after a return attempt, or return after delivery).
    winner = finals.sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime())[0]!;
  } else {
    const fresh = states.filter((s) => {
      const p = prec.get(s.source);
      const hours = p?.freshnessHours ?? 24;
      return now.getTime() - s.lastEventAt.getTime() <= hours * 36e5;
    });
    const pool = fresh.length ? fresh : states;
    pool.sort((a, b) => (prec.get(a.source)?.priority ?? 99) - (prec.get(b.source)?.priority ?? 99) || b.lastEventAt.getTime() - a.lastEventAt.getTime());
    winner = pool[0]!;
    for (const other of pool.slice(1)) if (other.status !== winner.status) conflicts.push({ winner: winner.source, loser: other.source, winnerStatus: winner.status, loserStatus: other.status });
  }
  let status = winner.status;
  const prev = input.previousStatus;
  // Never demote a terminal status with a non-final event.
  if (prev && SHIPMENT_FINAL_STATUSES.includes(prev) && !SHIPMENT_FINAL_STATUSES.includes(status)) status = prev;
  // Sticky exception.
  let exceptionReason = input.exceptionReason;
  let exceptionSince = input.exceptionSince;
  const wasException = prev ? EXCEPTION_LIKE.includes(prev) : false;
  const stale = exceptionSince ? now.getTime() - exceptionSince.getTime() > input.stickyExceptionDays * 864e5 : true;
  if (wasException && status === "in_transit" && exceptionReason && REAL_EXCEPTION_REASONS.has(exceptionReason) && !stale) status = prev!;
  if (EXCEPTION_LIKE.includes(status)) {
    if (!wasException || !exceptionSince) exceptionSince = winner.lastEventAt;
    if (!exceptionReason) exceptionReason = "source_exception";
  } else {
    exceptionReason = null;
    exceptionSince = null;
  }
  return { status, sourceOfTruth: winner.source, exceptionReason, exceptionSince, conflicts };
}

/** Days a shipment has been moving: from shipped_at to delivery or now. */
export function daysInTransit(shippedAt: Date | null, deliveredAt: Date | null, now = new Date()): number | null {
  if (!shippedAt) return null;
  return Math.max(0, Math.round(((deliveredAt ?? now).getTime() - shippedAt.getTime()) / 864e5));
}

export function isStuck(status: ShipmentStatus, shippedAt: Date | null, stuckDays: number, now = new Date()): boolean {
  if (!shippedAt || SHIPMENT_FINAL_STATUSES.includes(status)) return false;
  return (now.getTime() - shippedAt.getTime()) / 864e5 > stuckDays;
}
