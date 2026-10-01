import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, schema, sql } from "@keel/db";
import { type RETURN_RESOLUTIONS, isValidIban, matchesOrderLookup, needsBankDetails, normalizeTrackingCode, parsePortalConfig, rateLimitDecision, returnPortalConfigSchema, validatePortalAnswers, type ReturnPortalConfig, type TenantSettings } from "@keel/core";
import { encryptJson } from "@keel/integrations";
import { canWritePage, isTenantRole } from "@keel/config";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";
import { ReturnError, createReturn, listReturnReasons, orderReturnContext } from "./index";

/* ---------- configuration ---------- */

export async function getPortalConfig(ctx: ServiceContext): Promise<ReturnPortalConfig> {
  const [row] = await ctx.tx.select({ config: schema.returnPortalSettings.config }).from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, ctx.tenantId)).limit(1);
  return parsePortalConfig(row?.config);
}

/** Validates and stores the portal configuration; throws ReturnError("invalid_input") with the zod issues logged by the caller. */
export async function savePortalConfig(ctx: ServiceContext, raw: unknown): Promise<ReturnPortalConfig> {
  const parsed = returnPortalConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ReturnError("invalid_input");
  const keys = parsed.data.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new ReturnError("invalid_input");
  await ctx.tx
    .insert(schema.returnPortalSettings)
    .values({ tenantId: ctx.tenantId, config: parsed.data, updatedBy: ctx.actor.userId })
    .onConflictDoUpdate({ target: schema.returnPortalSettings.tenantId, set: { config: parsed.data, updatedBy: ctx.actor.userId, updatedAt: ctx.now ?? new Date() } });
  return parsed.data;
}

/* ---------- session token ---------- */

/** What the customer proved in the lookup: this tenant, this order, for one hour. */
export interface PortalSession {
  tenantId: string;
  orderId: string;
  /** Random per session: binds uploaded photos to the request being written. */
  nonce: string;
  exp: number;
}

function secret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.APP_ENCRYPTION_KEY;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return `return-portal:${s}`;
}

export function signPortalSession(p: Omit<PortalSession, "nonce" | "exp">, now = new Date(), ttlMinutes = 60): string {
  const payload: PortalSession = { ...p, nonce: randomBytes(12).toString("base64url"), exp: Math.floor(now.getTime() / 1000) + ttlMinutes * 60 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}

export function verifyPortalSession(token: string, now = new Date()): PortalSession | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as PortalSession;
    return p.exp * 1000 > now.getTime() ? p : null;
  } catch {
    return null;
  }
}

/** IPs are only kept as a salted hash, for rate limiting. */
export function hashIp(ip: string | null | undefined): string {
  return createHash("sha256").update(`${secret()}:${ip ?? "unknown"}`).digest("hex").slice(0, 32);
}

/* ---------- rate limit ---------- */

const LOOKUP_WINDOW_S = 15 * 60;
const LOOKUP_MAX_FAILURES = 5;

async function limiterState(ctx: ServiceContext, key: string) {
  const [row] = await ctx.tx.select().from(schema.publicRateLimits).where(and(eq(schema.publicRateLimits.tenantId, ctx.tenantId), eq(schema.publicRateLimits.key, key))).limit(1);
  return row ?? null;
}

async function isBlocked(ctx: ServiceContext, key: string, now: Date): Promise<number> {
  const row = await limiterState(ctx, key);
  if (!row) return 0;
  const age = (now.getTime() - row.windowStart.getTime()) / 1000;
  return age < LOOKUP_WINDOW_S && row.count >= LOOKUP_MAX_FAILURES ? Math.ceil(LOOKUP_WINDOW_S - age) : 0;
}

async function recordFailure(ctx: ServiceContext, key: string, now: Date): Promise<void> {
  const row = await limiterState(ctx, key);
  const d = rateLimitDecision(row ? { windowStart: row.windowStart, count: row.count } : null, now, LOOKUP_WINDOW_S, LOOKUP_MAX_FAILURES);
  await ctx.tx
    .insert(schema.publicRateLimits)
    .values({ tenantId: ctx.tenantId, key, windowStart: d.windowStart, count: d.count })
    .onConflictDoUpdate({ target: [schema.publicRateLimits.tenantId, schema.publicRateLimits.key], set: { windowStart: d.windowStart, count: d.count } });
}

/* ---------- lookup ---------- */

export class PortalError extends Error {
  constructor(
    public readonly code: "disabled" | "rate_limited" | "not_found" | "not_eligible" | "session_expired" | "invalid_input" | "resolution_not_allowed" | "reason_not_allowed" | "tracking_required" | "tracking_invalid" | "exchange_note_required" | "bank_details_required" | "iban_invalid" | "photos_required" | "too_many_photos" | "photo_too_large" | "photo_type" | "confirm_required" | "fields_invalid",
    public readonly detail?: unknown,
  ) {
    super(code);
  }
}

export interface PortalOrderView {
  token: string;
  orderName: string;
  firstName: string | null;
  paymentMethod: string;
  currency: string;
  eligible: boolean;
  ineligibleReason: string | null;
  deadline: Date | null;
  needsBankDetailsFor: string[];
  lines: { id: string; title: string; variantTitle: string | null; returnable: number; unitNetMinor: number }[];
  /** Lines the customer cannot return, with the reason (final sale, excluded, window closed). */
  blocked: { id: string; title: string; variantTitle: string | null; block: string }[];
  returns: { number: number; status: string; requestedAt: Date; resolution: string }[];
}

/**
 * Finds the order from number + email/phone. Returns null when nothing matches, after counting
 * the failure (returning instead of throwing keeps the counter: a throw would roll it back).
 */
export async function portalLookup(ctx: ServiceContext, settings: TenantSettings, tenant: { orderNumberPrefix: string }, config: ReturnPortalConfig, input: { orderNumber: string; contact: string; ip: string | null }): Promise<PortalOrderView | null> {
  if (!config.enabled) throw new PortalError("disabled");
  const now = ctx.now ?? new Date();
  const wanted = input.orderNumber.trim().replace(/^#/, "").toUpperCase().slice(0, 40);
  const ipKey = `lookup:ip:${hashIp(input.ip)}`;
  const orderKey = `lookup:order:${wanted}`;
  const wait = Math.max(await isBlocked(ctx, ipKey, now), await isBlocked(ctx, orderKey, now));
  if (wait) throw new PortalError("rate_limited", { retryAfterSeconds: wait });
  const prefix = tenant.orderNumberPrefix.toUpperCase();
  const names = [wanted, prefix && !wanted.startsWith(prefix) ? `${prefix}${wanted}` : null].filter(Boolean) as string[];
  const candidates = wanted ? await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, email: schema.orders.email, phone: schema.orders.phone, customerName: schema.orders.customerName }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), sql`upper(replace(${schema.orders.name}, '#', '')) = any(${sql.param(names)}::text[])`)).limit(5) : [];
  const match = candidates.find((o) => matchesOrderLookup(o, { orderNumber: input.orderNumber, contact: input.contact }, tenant.orderNumberPrefix, config.lookupBy));
  if (!match) {
    await recordFailure(ctx, ipKey, now);
    await recordFailure(ctx, orderKey, now);
    return null;
  }
  return portalOrderView(ctx, settings, config, match.id, signPortalSession({ tenantId: ctx.tenantId, orderId: match.id }, now));
}

/** Order as the customer sees it in the portal (also after a submission, with the same token). */
export async function portalOrderView(ctx: ServiceContext, settings: TenantSettings, config: ReturnPortalConfig, orderId: string, token: string): Promise<PortalOrderView> {
  const rc = await orderReturnContext(ctx, settings, orderId);
  const returns = await ctx.tx.select({ number: schema.returnRequests.number, status: schema.returnRequests.status, requestedAt: schema.returnRequests.requestedAt, resolution: schema.returnRequests.resolution }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.orderId, orderId))).orderBy(desc(schema.returnRequests.requestedAt));
  const lines = rc.lines.filter((l) => !l.excluded && l.returnable > 0).map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, returnable: l.returnable, unitNetMinor: l.unitNetMinor }));
  return {
    token,
    orderName: rc.order.name,
    firstName: rc.order.customerName?.split(/\s+/)[0] ?? null,
    paymentMethod: rc.order.paymentMethod,
    currency: rc.order.currency,
    eligible: rc.eligibility.eligible && lines.length > 0,
    ineligibleReason: rc.eligibility.eligible ? (lines.length ? null : "nothing_returnable") : rc.eligibility.reason,
    deadline: rc.eligibility.deadline,
    needsBankDetailsFor: config.resolutions.filter((r) => needsBankDetails(config, rc.order.paymentMethod, r)),
    lines,
    blocked: rc.lines.filter((l) => l.block && l.maxQuantity > 0).map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, block: l.block! })),
    returns,
  };
}

/* ---------- photos ---------- */

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PORTAL_PHOTO_MAX_BYTES = 1_500_000;

export async function savePortalPhoto(ctx: ServiceContext, config: ReturnPortalConfig, session: PortalSession, photo: { contentType: string; data: Buffer }): Promise<string> {
  if (config.photos.mode === "off") throw new PortalError("invalid_input");
  if (!PHOTO_TYPES.includes(photo.contentType)) throw new PortalError("photo_type");
  if (photo.data.length > PORTAL_PHOTO_MAX_BYTES) throw new PortalError("photo_too_large");
  const [count] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.sessionNonce, session.nonce), isNull(schema.returnEvidence.returnId)));
  if ((count?.n ?? 0) >= config.photos.max) throw new PortalError("too_many_photos");
  const [row] = await ctx.tx.insert(schema.returnEvidence).values({ tenantId: ctx.tenantId, sessionNonce: session.nonce, contentType: photo.contentType, sizeBytes: photo.data.length, data: photo.data }).returning({ id: schema.returnEvidence.id });
  return row!.id;
}

export async function deletePortalPhoto(ctx: ServiceContext, session: PortalSession, id: string): Promise<void> {
  await ctx.tx.delete(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.id, id), eq(schema.returnEvidence.sessionNonce, session.nonce), isNull(schema.returnEvidence.returnId)));
}

export async function returnEvidenceList(ctx: ServiceContext, returnId: string) {
  return ctx.tx.select({ id: schema.returnEvidence.id, contentType: schema.returnEvidence.contentType, sizeBytes: schema.returnEvidence.sizeBytes, createdAt: schema.returnEvidence.createdAt }).from(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.returnId, returnId))).orderBy(schema.returnEvidence.createdAt);
}

export async function returnEvidenceData(ctx: ServiceContext, returnId: string, id: string) {
  const [row] = await ctx.tx.select({ contentType: schema.returnEvidence.contentType, data: schema.returnEvidence.data }).from(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.returnId, returnId), eq(schema.returnEvidence.id, id))).limit(1);
  return row ?? null;
}

/* ---------- submission ---------- */

export interface PortalSubmitInput {
  lines: { orderLineId: string; quantity: number }[];
  reasonCode: string;
  resolution: string;
  customerNote?: string | null;
  exchangeNote?: string | null;
  trackingCode?: string | null;
  trackingCarrier?: string | null;
  bankHolder?: string | null;
  iban?: string | null;
  answers?: Record<string, unknown>;
  confirmed?: boolean;
  locale?: string | null;
  idempotencyKey?: string | null;
}

export async function portalSubmit(ctx: ServiceContext, settings: TenantSettings, config: ReturnPortalConfig, session: PortalSession, input: PortalSubmitInput): Promise<{ id: string; number: number; duplicate: boolean }> {
  if (!config.enabled) throw new PortalError("disabled");
  if (session.tenantId !== ctx.tenantId) throw new PortalError("session_expired");
  if (input.idempotencyKey) {
    const [dup] = await ctx.tx.select({ id: schema.returnRequests.id, number: schema.returnRequests.number }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.idempotencyKey, input.idempotencyKey))).limit(1);
    if (dup) return { ...dup, duplicate: true };
  }
  const resolution = input.resolution as (typeof RETURN_RESOLUTIONS)[number];
  if (!(config.resolutions as readonly string[]).includes(resolution)) throw new PortalError("resolution_not_allowed");
  const reasons = await listReturnReasons(ctx, true);
  if (!reasons.some((r) => r.code === input.reasonCode) || (config.reasonCodes.length && !config.reasonCodes.includes(input.reasonCode))) throw new PortalError("reason_not_allowed");
  let tracking: string | null = null;
  if (input.trackingCode?.trim()) {
    tracking = normalizeTrackingCode(input.trackingCode);
    if (!tracking) throw new PortalError("tracking_invalid");
  } else if (config.tracking.mode === "required") throw new PortalError("tracking_required");
  if (resolution === "exchange" && config.exchangeNoteRequired && !input.exchangeNote?.trim()) throw new PortalError("exchange_note_required");
  const answers = validatePortalAnswers(config.fields, input.answers ?? {});
  if (!answers.ok) throw new PortalError("fields_invalid", answers.errors);
  if (Object.keys(config.confirmText).length && !input.confirmed) throw new PortalError("confirm_required");
  const [order] = await ctx.tx.select({ paymentMethod: schema.orders.paymentMethod }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, session.orderId))).limit(1);
  if (!order) throw new PortalError("not_found");
  let bankDetailsEnc: string | null = null;
  if (needsBankDetails(config, order.paymentMethod, resolution)) {
    if (!input.bankHolder?.trim() || !input.iban?.trim()) throw new PortalError("bank_details_required");
    if (!isValidIban(input.iban)) throw new PortalError("iban_invalid");
    bankDetailsEnc = encryptJson({ holder: input.bankHolder.trim().slice(0, 120), iban: input.iban.replace(/\s+/g, "").toUpperCase() });
  }
  const [photos] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.sessionNonce, session.nonce), isNull(schema.returnEvidence.returnId)));
  if (config.photos.mode === "required" && !(photos?.n ?? 0)) throw new PortalError("photos_required");
  let created: { id: string; number: number };
  try {
    created = await createReturn(ctx, settings, {
      orderId: session.orderId,
      reasonCode: input.reasonCode,
      resolution,
      lines: input.lines,
      customerNote: input.customerNote?.trim().slice(0, 2000) || null,
      source: "portal",
      trackingCode: tracking,
      trackingCarrier: input.trackingCarrier?.trim().slice(0, 40) || null,
      exchangeNote: resolution === "exchange" ? input.exchangeNote?.trim().slice(0, 500) || null : null,
      customFields: answers.values,
      bankDetailsEnc,
      customerLocale: input.locale ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  } catch (e) {
    if (e instanceof ReturnError) throw new PortalError(e.code === "not_eligible" ? "not_eligible" : "invalid_input", e.code);
    throw e;
  }
  await ctx.tx.update(schema.returnEvidence).set({ returnId: created.id }).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), eq(schema.returnEvidence.sessionNonce, session.nonce), isNull(schema.returnEvidence.returnId)));
  // the team that handles returns hears about it
  const members = await ctx.tx.select({ userId: schema.tenantMemberships.userId, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(eq(schema.tenantMemberships.tenantId, ctx.tenantId));
  const userIds = members.filter((m) => isTenantRole(m.role) && canWritePage(m.role, "returns")).map((m) => m.userId);
  if (userIds.length) await notifyUsers(ctx, { userIds, type: "return_portal", title: `R-${created.number}`, body: input.customerNote?.slice(0, 140) ?? null, link: `/returns/${created.id}` });
  return { ...created, duplicate: false };
}

/** Removes photos uploaded in sessions that never submitted (older than a day). */
export async function purgeOrphanEvidence(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.tx.delete(schema.returnEvidence).where(and(eq(schema.returnEvidence.tenantId, ctx.tenantId), isNull(schema.returnEvidence.returnId), sql`${schema.returnEvidence.createdAt} < now() - interval '1 day'`)).returning({ id: schema.returnEvidence.id });
  return rows.length;
}

