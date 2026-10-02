import bcrypt from "bcryptjs";
import { and, eq, gt, gte, isNull, recordAudit, schema, sql, type Database, type DbExecutor } from "@keel/db";
import { emailAddressHash } from "@keel/integrations";
import { checkPassword, normalizeEmail } from "@keel/core";
import { queueEmail } from "../email/mailer";
import { appBaseUrl } from "../email/unsubscribe";
import { AccountError } from "./errors";
import { queueAccountNotice, userTimeZone } from "./notices";
import { hashAccountToken, ipHash, isWellFormedToken, newAccountToken, sameTokenHash } from "./tokens";

/**
 * Forgotten password (#52). `requestPasswordReset` answers the same way whether or not the address
 * belongs to someone (the caller always shows one message); an email leaves only when an active
 * account exists. The link holds a 32-byte token stored as SHA-256, valid 60 minutes, single use,
 * invalidated by a newer request or a successful reset. Requests are rate limited per address and
 * per IP over a sliding hour (rows of `password_resets`, also kept for unknown addresses).
 */
export const PASSWORD_RESET_MINUTES = 60;
export const RESETS_PER_EMAIL_PER_HOUR = 5;
/** Higher than per address: offices and mobile networks share an IP. */
export const RESETS_PER_IP_PER_HOUR = 20;
/** Attempts to submit a new password per token holder IP per hour (wrong or weak passwords included). */
export const RESET_SUBMITS_PER_IP_PER_HOUR = 20;

export const resetPasswordUrl = (raw: string) => `${appBaseUrl()}/reset-password/${raw}`;

/** A person who can sign in: a super-admin or a member of at least one workspace. */
async function activeAccount(db: DbExecutor, email: string) {
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale, isSuperAdmin: schema.users.isSuperAdmin }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!u) return null;
  if (u.isSuperAdmin) return u;
  const [m] = await db.select({ id: schema.tenantMemberships.id }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.userId, u.id), eq(schema.tenantMemberships.isActive, true))).limit(1);
  return m ? u : null;
}

export interface ResetRequestInput {
  email: string;
  ip?: string | null;
  /** A super-admin sending the reset from the console (same flow; the admin never sees the link). */
  requestedBy?: string | null;
  now?: Date;
}

/** Returns whether an email was queued: for tests and the console only, never shown to the person asking. */
export async function requestPasswordReset(db: DbExecutor, input: ResetRequestInput): Promise<{ sent: boolean }> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!email) throw new AccountError("invalid_input");
  const emailHash = emailAddressHash(email);
  const ip = input.requestedBy ? null : ipHash(input.ip);
  const since = new Date(now.getTime() - 3600_000);
  const r = schema.passwordResets;
  const [byEmail] = await db.select({ n: sql<number>`count(*)::int` }).from(r).where(and(eq(r.emailHash, emailHash), gte(r.createdAt, since)));
  if ((byEmail?.n ?? 0) >= RESETS_PER_EMAIL_PER_HOUR) throw new AccountError("rate_limited");
  if (ip) {
    const [byIp] = await db.select({ n: sql<number>`count(*)::int` }).from(r).where(and(eq(r.ipHash, ip), gte(r.createdAt, since)));
    if ((byIp?.n ?? 0) >= RESETS_PER_IP_PER_HOUR) throw new AccountError("rate_limited");
  }
  const user = await activeAccount(db, email);
  if (!user) {
    await db.insert(r).values({ emailHash, ipHash: ip, requestedBy: input.requestedBy ?? null, createdAt: now });
    return { sent: false };
  }
  // a newer request invalidates every earlier link
  await db.update(r).set({ invalidatedAt: now }).where(and(eq(r.userId, user.id), isNull(r.usedAt), isNull(r.invalidatedAt)));
  const token = newAccountToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60_000);
  const [row] = await db.insert(r).values({ userId: user.id, emailHash, ipHash: ip, tokenHash: token.hash, expiresAt, requestedBy: input.requestedBy ?? null, createdAt: now }).returning({ id: r.id });
  await queueEmail({ db, now }, { to: user.email, template: "password_reset", data: { url: resetPasswordUrl(token.raw), minutes: PASSWORD_RESET_MINUTES }, locale: user.locale, event: `password-reset:${token.hash}`, expiresAt });
  await recordAudit(db, { tenantId: null, actorUserId: input.requestedBy ?? user.id, actorType: input.requestedBy ? "super_admin" : "user", action: "account.password_reset_requested", entityType: "user", entityId: user.id, metadata: { requestId: row!.id, via: input.requestedBy ? "admin" : "self", expiresAt: expiresAt.toISOString() }, ip: input.requestedBy ? null : (input.ip ?? null) });
  return { sent: true };
}

export type ResetTokenState = "valid" | "expired" | "used" | "invalid";

async function rowByToken(db: DbExecutor, raw: string) {
  if (!isWellFormedToken(raw)) return null;
  const hash = hashAccountToken(raw);
  const [row] = await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.tokenHash, hash)).limit(1);
  return row?.tokenHash && sameTokenHash(row.tokenHash, hash) ? row : null;
}

function stateOf(row: typeof schema.passwordResets.$inferSelect | null, now: Date): ResetTokenState {
  if (!row || !row.userId || !row.expiresAt) return "invalid";
  if (row.usedAt || row.invalidatedAt) return "used";
  return row.expiresAt <= now ? "expired" : "valid";
}

/** What the reset page shows before the form: the form, or "ask for a new link". */
export async function inspectPasswordReset(db: DbExecutor, raw: string, now = new Date()): Promise<{ state: ResetTokenState; email: string | null }> {
  const row = await rowByToken(db, raw);
  const state = stateOf(row, now);
  if (state !== "valid") return { state, email: null };
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, row!.userId!)).limit(1);
  return { state: u ? "valid" : "invalid", email: u?.email ?? null };
}

/**
 * Sets the new password: the token is used once, every other link of the person stops working, the
 * session version moves (every session signs out) and the "password changed" notice is queued.
 */
export async function completePasswordReset(db: Database, raw: string, newPassword: string, opts: { ip?: string | null; now?: Date } = {}): Promise<{ userId: string; sessionVersion: number }> {
  const now = opts.now ?? new Date();
  const ip = ipHash(opts.ip);
  if (ip) {
    const since = new Date(now.getTime() - 3600_000);
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "account.password_reset_failed"), gte(schema.auditLogs.createdAt, since), sql`${schema.auditLogs.metadata}->>'ipHash' = ${ip}`));
    if ((n?.n ?? 0) >= RESET_SUBMITS_PER_IP_PER_HOUR) throw new AccountError("rate_limited");
  }
  return db.transaction(async (tx) => {
    const row = await rowByToken(tx, raw);
    const state = stateOf(row, now);
    if (state !== "valid") {
      await recordAudit(tx, { tenantId: null, actorType: "system", action: "account.password_reset_failed", entityType: "user", entityId: row?.userId ?? undefined, metadata: { reason: state, ...(ip ? { ipHash: ip } : {}) } });
      throw new AccountError(state === "expired" ? "expired_token" : state === "used" ? "used_token" : "invalid_token");
    }
    const userId = row!.userId!;
    const [user] = await tx.select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale, sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new AccountError("invalid_token");
    const strength = checkPassword(newPassword, { email: user.email, name: user.name });
    if (!strength.ok) throw new AccountError("weak_password", strength.issues);
    const r = schema.passwordResets;
    const [claimed] = await tx
      .update(r)
      .set({ usedAt: now })
      .where(and(eq(r.id, row!.id), isNull(r.usedAt), isNull(r.invalidatedAt), gt(r.expiresAt, now)))
      .returning({ id: r.id });
    if (!claimed) throw new AccountError("used_token");
    await tx.update(r).set({ invalidatedAt: now }).where(and(eq(r.userId, userId), isNull(r.usedAt), isNull(r.invalidatedAt)));
    const [updated] = await tx
      .update(schema.users)
      .set({ passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: now, sessionVersion: sql`${schema.users.sessionVersion} + 1`, emailVerified: sql`coalesce(${schema.users.emailVerified}, ${now.toISOString()}::timestamptz)` })
      .where(eq(schema.users.id, userId))
      .returning({ sessionVersion: schema.users.sessionVersion });
    await recordAudit(tx, { tenantId: null, actorUserId: userId, actorType: "user", action: "account.password_reset_completed", entityType: "user", entityId: userId, diff: { password: { from: "***", to: "***" }, sessionVersion: { from: user.sessionVersion, to: updated!.sessionVersion } }, metadata: { requestId: row!.id }, ip: opts.ip ?? null });
    await queueAccountNotice({ db: tx, now }, { to: user.email, template: "password_changed", data: { at: now, timezone: await userTimeZone(tx, userId) }, locale: user.locale, event: `password-changed:${row!.id}` });
    return { userId, sessionVersion: updated!.sessionVersion };
  });
}
