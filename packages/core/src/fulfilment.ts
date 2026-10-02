import { validateAddressFormat, type AddressIssue, type PostalAddress } from "./address";
import { SHIPMENT_FINAL_STATUSES, type PaymentStatus, type ShipmentStatus } from "./domain";

/**
 * Fulfilment operations (issue #28): business-day clock for the late-to-ship queue, pick/pack
 * stages, delivery-exception cases and return-to-sender follow-ups. Pure, payment-method agnostic:
 * "ready to ship" is the canonical status decided by the tenant's rules, never the payment method.
 */

/* ---------- calendar in the tenant time zone ---------- */

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in a time zone; unknown zones fall back to UTC. */
export function localDateKey(d: Date, timeZone: string): string {
  const tz = safeZone(timeZone);
  let f = dateKeyFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateKeyFormatters.set(tz, f);
  }
  return f.format(d);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a `YYYY-MM-DD` date. */
export function isoWeekday(dateKey: string): number {
  const d = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDaysToKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeZone(timeZone), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The instant a local day starts in a time zone (DST-safe: the offset is re-read at the result). */
export function zonedDayStart(dateKey: string, timeZone: string): Date {
  const guess = new Date(`${dateKey}T00:00:00Z`).getTime();
  let at = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  at = guess - offsetMinutes(new Date(at), timeZone) * 60000;
  return new Date(at);
}

export const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * Working days elapsed since an instant, counted on local dates: the working days after the day of
 * `from` up to and including today. An order placed on Monday is 0 on Monday, 1 on Tuesday; one
 * placed on Saturday is 1 on Monday.
 */
export function businessDaysElapsed(from: Date, now: Date, timeZone: string, workdays: readonly number[] = DEFAULT_WORKDAYS): number {
  const work = new Set(workdays.length ? workdays : DEFAULT_WORKDAYS);
  const start = localDateKey(from, timeZone);
  const end = localDateKey(now, timeZone);
  if (start >= end) return 0;
  let count = 0;
  let key = addDaysToKey(start, 1);
  // bounded: the queue only looks back a few months
  for (let i = 0; key <= end && i < 4000; i++, key = addDaysToKey(key, 1)) if (work.has(isoWeekday(key))) count++;
  return count;
}

/**
 * Instant before which an order placed is late: the start of the (threshold + 1)-th most recent
 * working day up to today. `placedAt < cutoff` ⇔ `businessDaysElapsed(placedAt) > threshold`, so
 * the database filters with one comparison and the page explains the same number.
 */
export function lateToShipCutoff(now: Date, thresholdDays: number, timeZone: string, workdays: readonly number[] = DEFAULT_WORKDAYS): Date {
  const work = new Set(workdays.length ? workdays : DEFAULT_WORKDAYS);
  let key = localDateKey(now, timeZone);
  let seen = 0;
  for (let i = 0; i < 4000; i++, key = addDaysToKey(key, -1)) {
    if (!work.has(isoWeekday(key))) continue;
    seen++;
    if (seen === Math.max(0, thresholdDays) + 1) break;
  }
  return zonedDayStart(key, timeZone);
}

/* ---------- to ship and pick/pack ---------- */

/** Statuses in which an order is expected to leave the warehouse (decided by the tenant's rules). */
export const TO_SHIP_STATUSES = ["confirmed", "fulfilling"] as const;

export interface ToShipFacts {
  status: string;
  fulfillmentStatusRaw: string | null;
  /** The order already has a shipment (from the platform or shipped from Keel). */
  hasShipment: boolean;
}

/** Ready to ship and nothing shipped yet, whatever the payment method. */
export function isToShip(o: ToShipFacts): boolean {
  return (TO_SHIP_STATUSES as readonly string[]).includes(o.status) && !o.hasShipment && (o.fulfillmentStatusRaw ?? "").toLowerCase() !== "fulfilled";
}

export interface LateToShipOptions {
  thresholdDays: number;
  timeZone: string;
  workdays?: readonly number[];
}

export const PACK_STAGES = ["pending", "packed", "shipped"] as const;
export type PackStage = (typeof PACK_STAGES)[number];

export function packStage(o: { hasShipment: boolean; packedAt: Date | null }): PackStage {
  if (o.hasShipment) return "shipped";
  return o.packedAt ? "packed" : "pending";
}

export interface ShipInput {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | null;
}
export type ShipInputIssue = { field: "carrier" | "trackingNumber" | "trackingUrl"; code: "required" | "too_long" | "invalid" };

export function validateShipInput(i: ShipInput): ShipInputIssue[] {
  const issues: ShipInputIssue[] = [];
  const carrier = i.carrier.trim();
  const tracking = i.trackingNumber.trim();
  if (!carrier) issues.push({ field: "carrier", code: "required" });
  else if (carrier.length > 60) issues.push({ field: "carrier", code: "too_long" });
  if (!tracking) issues.push({ field: "trackingNumber", code: "required" });
  else if (tracking.length > 80) issues.push({ field: "trackingNumber", code: "too_long" });
  else if (!/^[\w.\-/ ]+$/.test(tracking)) issues.push({ field: "trackingNumber", code: "invalid" });
  const url = i.trackingUrl?.trim();
  if (url && !/^https?:\/\/\S{3,500}$/.test(url)) issues.push({ field: "trackingUrl", code: "invalid" });
  return issues;
}

/* ---------- status mappings (source external status → canonical) ---------- */

export interface StatusMapping {
  source: string;
  externalStatus: string;
  canonicalStatus: ShipmentStatus;
  isException: boolean;
  isFinal: boolean;
}
export interface MappedStatus {
  status: ShipmentStatus;
  isException: boolean;
  isFinal: boolean;
  /** True when a tenant row decided it, false when the adapter's own normalization was kept. */
  mapped: boolean;
}

export const normalizeExternalStatus = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The tenant's mapping wins over the adapter's normalized status; matching ignores case and spaces at the ends. */
export function applyStatusMapping(mappings: readonly StatusMapping[], source: string, externalStatus: string | null | undefined, fallback: ShipmentStatus): MappedStatus {
  const ext = normalizeExternalStatus(externalStatus);
  const m = ext ? mappings.find((x) => x.source === source && normalizeExternalStatus(x.externalStatus) === ext) : undefined;
  if (m) return { status: m.canonicalStatus, isException: m.isException, isFinal: m.isFinal, mapped: true };
  return { status: fallback, isException: EXCEPTION_LIKE.includes(fallback), isFinal: SHIPMENT_FINAL_STATUSES.includes(fallback), mapped: false };
}

/* ---------- delivery-exception and return-to-sender cases ---------- */

export const CASE_KINDS = ["exception", "return_to_sender"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const EXCEPTION_RESOLUTIONS = ["redeliver", "new_address", "pickup_point", "return"] as const;
export type ExceptionResolution = (typeof EXCEPTION_RESOLUTIONS)[number];
export const INSTRUCTION_CHANNELS = ["carrier", "email"] as const;
export type InstructionChannel = (typeof INSTRUCTION_CHANNELS)[number];

/** Non-final statuses that need someone to act (a mapping row can flag more). */
export const EXCEPTION_LIKE: readonly ShipmentStatus[] = ["exception", "attempted"];
/** Final statuses where the parcel goes back to the merchant. */
export const RETURN_TO_SENDER_STATUSES: readonly ShipmentStatus[] = ["returned", "failed"];

export interface CaseShipment {
  id: string;
  status: ShipmentStatus;
  /** Set when a mapping row flags the current status as an exception. */
  flaggedException?: boolean;
  /** When the shipment entered its current state (exception since, last event). */
  changedAt?: Date | null;
}
export interface OpenCase {
  id: string;
  shipmentId: string;
  kind: CaseKind;
}
export interface ClosedCase {
  shipmentId: string;
  kind: CaseKind;
  closedAt: Date;
}
export interface CasePlan {
  open: { shipmentId: string; kind: CaseKind }[];
  close: { caseId: string; reason: "moved_on" }[];
}

export function shipmentNeedsCase(s: CaseShipment): CaseKind | null {
  if (RETURN_TO_SENDER_STATUSES.includes(s.status)) return "return_to_sender";
  if (EXCEPTION_LIKE.includes(s.status) || (s.flaggedException && !SHIPMENT_FINAL_STATUSES.includes(s.status))) return "exception";
  return null;
}

/**
 * Which cases to open and which to close: an exception shipment gets one open exception case; it
 * closes by itself when the shipment moves on (back in transit, delivered, returned). A parcel
 * coming back gets one return-to-sender review, closed by a person once the follow-ups are done.
 * A closed case is not reopened: a review never, an exception only when the shipment fell into
 * exception again after the case was closed.
 */
export function planShipmentCases(shipments: readonly CaseShipment[], openCases: readonly OpenCase[], closedCases: readonly ClosedCase[] = []): CasePlan {
  const plan: CasePlan = { open: [], close: [] };
  for (const s of shipments) {
    const need = shipmentNeedsCase(s);
    const mine = openCases.filter((c) => c.shipmentId === s.id);
    for (const c of mine) if (c.kind === "exception" && need !== "exception") plan.close.push({ caseId: c.id, reason: "moved_on" });
    if (!need || mine.some((c) => c.kind === need)) continue;
    const last = closedCases.filter((c) => c.shipmentId === s.id && c.kind === need).reduce<Date | null>((m, c) => (!m || c.closedAt > m ? c.closedAt : m), null);
    if (last && (need === "return_to_sender" || !s.changedAt || s.changedAt <= last)) continue;
    plan.open.push({ shipmentId: s.id, kind: need });
  }
  return plan;
}

export interface ResolutionInput {
  resolution: ExceptionResolution;
  address?: PostalAddress | null;
  pickupPoint?: string | null;
  note?: string | null;
}
export type ResolutionIssue = { field: "resolution" | "pickupPoint" | "note"; code: "required" | "too_long" | "invalid" } | { field: "address"; code: "invalid"; issues: AddressIssue[] };

export function validateResolution(r: ResolutionInput): ResolutionIssue[] {
  if (!(EXCEPTION_RESOLUTIONS as readonly string[]).includes(r.resolution)) return [{ field: "resolution", code: "invalid" }];
  const issues: ResolutionIssue[] = [];
  if (r.resolution === "new_address") {
    const a = validateAddressFormat(r.address);
    if (a.length) issues.push({ field: "address", code: "invalid", issues: a });
  }
  if (r.resolution === "pickup_point") {
    const p = r.pickupPoint?.trim() ?? "";
    if (!p) issues.push({ field: "pickupPoint", code: "required" });
    else if (p.length > 200) issues.push({ field: "pickupPoint", code: "too_long" });
  }
  if ((r.note ?? "").length > 1000) issues.push({ field: "note", code: "too_long" });
  return issues;
}

export const RTS_FOLLOW_UPS = ["restock", "refund", "contact"] as const;
export type RtsFollowUp = (typeof RTS_FOLLOW_UPS)[number];
export interface RtsFacts {
  paymentStatus: PaymentStatus | string;
  totalMinor: number;
  refundedMinor: number;
  /** Units already put back in stock for this order (a return or a manual restock). */
  restocked: boolean;
  hasContact: boolean;
}
export interface RtsSuggestion {
  kind: RtsFollowUp;
  reason: "units_back" | "money_captured" | "nothing_captured" | "already_refunded" | "tell_customer" | "no_contact";
  suggested: boolean;
}

/**
 * Suggested follow-ups for a parcel back at the sender. Payment-method agnostic: a refund is
 * suggested when money was captured and not yet given back; nothing is automated (cancelling and
 * voiding an uncaptured payment belongs to the add-on that owns that payment flow).
 */
export function suggestRtsFollowUps(f: RtsFacts): RtsSuggestion[] {
  const captured = f.paymentStatus === "paid" || f.paymentStatus === "partially_refunded";
  const refundable = captured && f.refundedMinor < f.totalMinor;
  return [
    { kind: "restock", reason: "units_back", suggested: !f.restocked },
    { kind: "refund", reason: refundable ? "money_captured" : captured ? "already_refunded" : "nothing_captured", suggested: refundable },
    { kind: "contact", reason: f.hasContact ? "tell_customer" : "no_contact", suggested: f.hasContact },
  ];
}
