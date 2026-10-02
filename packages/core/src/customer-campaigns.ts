import { localDateKey, addDaysToKey, zonedWallTime } from "./fulfilment";

/**
 * Customer campaigns workflow (add-on `addon.customer_campaigns`, issue #34): approval states,
 * send window and throttle, frequency cap, exclusions and the send idempotency key. Pure: the
 * services read the facts from the database and the worker applies the decisions.
 */

/**
 * One-off: draft → pending_approval → approved → scheduled → sending → sent.
 * Sequence (always-on): draft → pending_approval → approved → active ⇄ paused.
 */
export const RETENTION_CAMPAIGN_STATUSES = ["draft", "pending_approval", "approved", "scheduled", "sending", "sent", "active", "paused"] as const;
export type RetentionCampaignStatus = (typeof RETENTION_CAMPAIGN_STATUSES)[number];
export const RETENTION_CAMPAIGN_KINDS = ["one_off", "sequence"] as const;
export type RetentionCampaignKind = (typeof RETENTION_CAMPAIGN_KINDS)[number];

export type RetentionCampaignAction = "submit" | "approve" | "reject" | "reopen" | "schedule" | "unschedule" | "start" | "finish" | "activate" | "pause";

const TRANSITIONS: Record<RetentionCampaignKind, Partial<Record<RetentionCampaignAction, Partial<Record<RetentionCampaignStatus, RetentionCampaignStatus>>>>> = {
  one_off: {
    submit: { draft: "pending_approval" },
    approve: { pending_approval: "approved" },
    reject: { pending_approval: "draft" },
    reopen: { pending_approval: "draft", approved: "draft", scheduled: "draft" },
    schedule: { approved: "scheduled" },
    unschedule: { scheduled: "approved" },
    start: { scheduled: "sending" },
    finish: { sending: "sent" },
  },
  sequence: {
    submit: { draft: "pending_approval" },
    approve: { pending_approval: "approved" },
    reject: { pending_approval: "draft" },
    reopen: { pending_approval: "draft", approved: "draft", paused: "draft" },
    activate: { approved: "active", paused: "active" },
    pause: { active: "paused" },
  },
};

/** The status an action leads to, or null when the action is not allowed from this status. */
export function nextCampaignStatus(kind: RetentionCampaignKind, status: string, action: RetentionCampaignAction): RetentionCampaignStatus | null {
  return TRANSITIONS[kind]?.[action]?.[status as RetentionCampaignStatus] ?? null;
}

/** Content (segment, message, channel…) can change only in draft: anything later was approved as it is. */
export const isCampaignEditable = (status: string) => status === "draft";
/** Statuses in which messages may be going out. */
export const isCampaignDelivering = (kind: RetentionCampaignKind, status: string) => (kind === "sequence" ? status === "active" : status === "sending");

/**
 * Four-eyes rule: an approver needs the approval permission (role matrix, `approve_customer_campaign`)
 * and cannot approve their own campaign, unless they are the owner.
 */
export function canApproveCampaign(input: { roleCanApprove: boolean; isOwner: boolean; isAuthor: boolean }): boolean {
  return input.roleCanApprove && (!input.isAuthor || input.isOwner);
}

/* ---------- send window ---------- */

export interface SendWindow {
  /** Local hours [start, end) in the tenant time zone; start > end is an overnight window. */
  startHour: number;
  endHour: number;
  timeZone: string;
}

function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeZone(timeZone), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (n("hour") % 24) * 60 + n("minute");
}
function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Whether messages may go out at this instant. A window of 0–24 is always open. */
export function isInSendWindow(at: Date, w: SendWindow): boolean {
  const start = w.startHour * 60;
  const end = w.endHour * 60;
  if (start === end) return false;
  const m = localMinutes(at, w.timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The first instant at or after `at` inside the window (DST-safe through the zone's offset). */
export function nextSendWindowStart(at: Date, w: SendWindow): Date {
  if (isInSendWindow(at, w)) return at;
  const today = localDateKey(at, w.timeZone);
  for (let d = 0; d <= 2; d++) {
    const candidate = zonedWallTime(addDaysToKey(today, d), w.startHour, 0, w.timeZone);
    if (candidate.getTime() >= at.getTime()) return candidate;
  }
  return zonedWallTime(addDaysToKey(today, 1), w.startHour, 0, w.timeZone);
}

/** When a campaign scheduled for `requested` will actually start: the request, moved to the window if it falls outside. */
export function effectiveSendStart(requested: Date, now: Date, w: SendWindow): Date {
  return nextSendWindowStart(requested.getTime() < now.getTime() ? now : requested, w);
}

/* ---------- throttle, cap, retries ---------- */

/** Messages a channel may still send in the current minute. */
export function throttleAllowance(perMinute: number, sentInLastMinute: number): number {
  return Math.max(0, Math.floor(perMinute) - Math.max(0, sentInLastMinute));
}

/** A customer who already received `cap` campaign messages in the last `days` days gets no more. */
export function isOverFrequencyCap(messagesInWindow: number, cap: number): boolean {
  return messagesInWindow >= cap;
}

export const CAMPAIGN_SEND_MAX_ATTEMPTS = 4;
/** Backoff after a failed attempt: 1, 4, 16 minutes. */
export function campaignRetryDelayMs(attempts: number): number {
  return 60_000 * 4 ** Math.max(0, attempts - 1);
}

/** One message per campaign, customer and channel: the provider receives it at most once even when a crashed batch is resent. */
export function campaignMessageKey(campaignId: string, customerId: string, channel: string): string {
  return `rc:${campaignId}:${customerId}:${channel}`;
}

/* ---------- exclusions ---------- */

/**
 * Why a segment member is not messaged, first matching reason in this order. Every reason but
 * `holdout` removes the customer from both groups (the comparison stays fair); `holdout` is the
 * control group itself, recorded but never contacted.
 */
export const CAMPAIGN_EXCLUSION_REASONS = ["no_consent", "suppressed", "over_cap", "open_order", "in_measurement", "holdout"] as const;
export type CampaignExclusionReason = (typeof CAMPAIGN_EXCLUSION_REASONS)[number];

export interface CampaignCandidate {
  acceptsMarketing: boolean;
  suppressed: boolean;
  /** Campaign messages received in the frequency window. */
  recentMessages: number;
  hasOpenOrder: boolean;
  /** Treated or control customer of another campaign whose measurement window is open. */
  inMeasurement: boolean;
  group: "treated" | "holdout";
}

export interface ExclusionRules {
  frequencyCap: number;
  excludeOpenOrders: boolean;
  measurementLock: boolean;
}

export function campaignExclusion(c: CampaignCandidate, r: ExclusionRules): CampaignExclusionReason | null {
  if (!c.acceptsMarketing) return "no_consent";
  if (c.suppressed) return "suppressed";
  if (isOverFrequencyCap(c.recentMessages, r.frequencyCap)) return "over_cap";
  if (r.excludeOpenOrders && c.hasOpenOrder) return "open_order";
  if (r.measurementLock && c.inMeasurement) return "in_measurement";
  if (c.group === "holdout") return "holdout";
  return null;
}

export type ExclusionCounts = Record<CampaignExclusionReason, number>;
export function emptyExclusionCounts(): ExclusionCounts {
  return Object.fromEntries(CAMPAIGN_EXCLUSION_REASONS.map((r) => [r, 0])) as ExclusionCounts;
}
