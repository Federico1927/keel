import type { ReturnStatus } from "./domain";
import { RETURN_CLOSED_STATUSES } from "./returns";

/* Returns created on the commerce platform (issue #35): what Keel makes of the platform's status, and how long returns sit in each state. */

/** Status Keel gives a return the platform reports; `needsReview` when staff has to decide the outcome. */
export interface PlatformReturnTarget {
  status: ReturnStatus;
  needsReview: boolean;
  /** Last state on the platform as Keel stores it (`return_requests.platform_status`). */
  platformStatus: "requested" | "approved" | "declined" | "closed";
}

/**
 * Platform return status (Shopify `ReturnStatus`: REQUESTED, OPEN, DECLINED, CANCELED, CLOSED, lower-cased) → Keel status.
 * A closed return is refunded when the order carries a refund; otherwise the goods are back but the outcome
 * (exchange, credit) was settled outside Keel, so it stays `received` and is flagged for review.
 */
export function platformReturnTarget(platformStatus: string, facts: { orderRefunded: boolean }): PlatformReturnTarget {
  switch (platformStatus.toLowerCase()) {
    case "open":
    case "approved":
    case "in_progress":
      return { status: "approved", needsReview: false, platformStatus: "approved" };
    case "declined":
      return { status: "rejected", needsReview: false, platformStatus: "declined" };
    case "canceled":
    case "cancelled":
      return { status: "rejected", needsReview: false, platformStatus: "declined" };
    case "closed":
      return facts.orderRefunded ? { status: "refunded", needsReview: false, platformStatus: "closed" } : { status: "received", needsReview: true, platformStatus: "closed" };
    default:
      return { status: "requested", needsReview: false, platformStatus: "requested" };
  }
}

const RANK: Record<ReturnStatus, number> = { requested: 0, approved: 1, received: 2, inspected: 3, refunded: 4, exchanged: 4, voucher_issued: 4, rejected: 4 };

/**
 * The status a platform update moves a Keel return to, or null when Keel keeps its own. The platform only
 * moves a return forward: Keel may be ahead (received, inspected in Keel while the platform still says open),
 * and a closed return never reopens. A decline or cancel rejects a return that is still open in Keel.
 */
export function nextReturnStatusFromPlatform(current: string, target: ReturnStatus): ReturnStatus | null {
  if (current === target) return null;
  if ((RETURN_CLOSED_STATUSES as readonly string[]).includes(current)) return null;
  if (target === "rejected") return current === "requested" || current === "approved" ? "rejected" : null;
  const from = RANK[current as ReturnStatus];
  if (from === undefined) return target;
  return RANK[target] > from ? target : null;
}

/** The tenant reason for a platform reason code: the one mapped to it, else `other`, else the first active one, else the raw code. */
export function matchReturnReason(platformReason: string | null | undefined, reasons: { code: string; platformReason: string | null; isActive?: boolean }[]): string {
  const wanted = (platformReason ?? "").toUpperCase();
  const active = reasons.filter((r) => r.isActive !== false);
  const mapped = wanted ? active.find((r) => (r.platformReason ?? "").toUpperCase() === wanted) : undefined;
  if (mapped) return mapped.code;
  const other = active.find((r) => r.code === "other") ?? active.find((r) => !r.platformReason || r.platformReason.toUpperCase() === "OTHER");
  return other?.code ?? active[0]?.code ?? (wanted ? wanted.toLowerCase() : "other");
}

/* ---------- ageing ---------- */

export const RETURN_AGEING_STAGES = ["requested", "approved", "received", "inspected"] as const;
export type ReturnAgeingStage = (typeof RETURN_AGEING_STAGES)[number];

export interface ReturnTimeline {
  status: string;
  requestedAt: Date;
  approvedAt: Date | null;
  receivedAt: Date | null;
  /** When the inspection was recorded (from the timeline); null when there was none. */
  inspectedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Time spent in each open stage, in days. A stage starts at its timestamp and ends where the next known
 * one starts; the stage the return is in now runs until `now`. Stages the return skipped (a returnless
 * refund never received, a rejection at request) are left out.
 */
export function returnStageDays(r: ReturnTimeline, now: Date): Partial<Record<ReturnAgeingStage, number>> {
  const starts: [ReturnAgeingStage, Date | null][] = [["requested", r.requestedAt], ["approved", r.approvedAt], ["received", r.receivedAt], ["inspected", r.inspectedAt]];
  const out: Partial<Record<ReturnAgeingStage, number>> = {};
  const closed = (RETURN_CLOSED_STATUSES as readonly string[]).includes(r.status);
  for (let i = 0; i < starts.length; i++) {
    const [stage, start] = starts[i]!;
    if (!start) continue;
    const next = starts.slice(i + 1).find(([, d]) => d !== null)?.[1] ?? null;
    const end = next ?? r.closedAt ?? (closed ? null : r.status === stage ? now : null);
    if (!end) continue;
    out[stage] = Math.max(0, (end.getTime() - start.getTime()) / 864e5);
  }
  return out;
}

export interface ReturnsAgeing {
  /** Per stage: returns that went through it, average, median and longest days spent there. */
  stages: { stage: ReturnAgeingStage; count: number; avgDays: number; medianDays: number; maxDays: number }[];
  /** Open returns by the stage they are in now: how many, average and oldest age in that stage, and how many are older than `staleDays`. */
  open: { stage: ReturnAgeingStage; count: number; avgDays: number; oldestDays: number; stale: number }[];
  staleDays: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function returnsAgeing(rows: ReturnTimeline[], now: Date, staleDays = 7): ReturnsAgeing {
  const per = new Map<ReturnAgeingStage, number[]>();
  const open = new Map<ReturnAgeingStage, number[]>();
  for (const r of rows) {
    const days = returnStageDays(r, now);
    for (const s of RETURN_AGEING_STAGES) if (days[s] !== undefined) (per.get(s) ?? per.set(s, []).get(s)!).push(days[s]!);
    if ((RETURN_AGEING_STAGES as readonly string[]).includes(r.status) && days[r.status as ReturnAgeingStage] !== undefined) (open.get(r.status as ReturnAgeingStage) ?? open.set(r.status as ReturnAgeingStage, []).get(r.status as ReturnAgeingStage)!).push(days[r.status as ReturnAgeingStage]!);
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  return {
    staleDays,
    stages: RETURN_AGEING_STAGES.filter((s) => per.get(s)?.length).map((s) => {
      const xs = per.get(s)!;
      return { stage: s, count: xs.length, avgDays: round1(xs.reduce((a, b) => a + b, 0) / xs.length), medianDays: round1(median(xs)), maxDays: round1(Math.max(...xs)) };
    }),
    open: RETURN_AGEING_STAGES.filter((s) => open.get(s)?.length).map((s) => {
      const xs = open.get(s)!;
      return { stage: s, count: xs.length, avgDays: round1(xs.reduce((a, b) => a + b, 0) / xs.length), oldestDays: round1(Math.max(...xs)), stale: xs.filter((x) => x > staleDays).length };
    }),
  };
}
