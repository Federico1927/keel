import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { and, desc, eq, gte, inArray, like, lt, schema, sql, recordAudit, type DbExecutor } from "@keel/db";
import { SUPPORTED_LOCALES } from "@keel/config";
import { checkPassword, diffRecords, hasChanges, isTimeZone, normalizeEmail, type PasswordIssue } from "@keel/core";
import type { NotificationSink } from "@keel/integrations";

/**
 * The signed-in person's own account (#45): profile, preferences, password, email, sessions.
 * Users are platform rows (no tenant), so these functions take the admin executor and the id of
 * the user acting on themselves; nothing here can reach another user's row. Every change writes a
 * platform audit row (tenant null, actor = the user, field diff, never secrets).
 */
export interface AccountContext {
  db: DbExecutor;
  userId: string;
  ip?: string | null;
  now?: Date;
}

export class AccountError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "rate_limited" | "wrong_password" | "weak_password" | "email_taken" | "same_email" | "invalid_token" | "expired_token",
    readonly issues: PasswordIssue[] = [],
  ) {
    super(code);
    this.name = "AccountError";
  }
}

const THEME_VALUES = ["light", "dark", "system"] as const;
const DENSITY_VALUES = ["comfortable", "compact"] as const;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

export const profileInputSchema = z.object({ name: z.string().trim().min(1).max(120), preferredName: optionalText(60), jobTitle: optionalText(80) });
export const preferencesInputSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES).nullable(),
  theme: z.enum(THEME_VALUES),
  density: z.enum(DENSITY_VALUES),
  timeZone: z
    .string()
    .nullable()
    .refine((v) => v === null || isTimeZone(v), "invalid_time_zone"),
});
export type ProfileInput = z.input<typeof profileInputSchema>;
export type PreferencesInput = z.input<typeof preferencesInputSchema>;

export interface AccountProfile {
  id: string;
  email: string;
  name: string | null;
  preferredName: string | null;
  jobTitle: string | null;
  locale: string | null;
  timeZone: string | null;
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  isSuperAdmin: boolean;
  hasAvatar: boolean;
  avatarVersion: number | null;
  sessionVersion: number;
  passwordChangedAt: Date | null;
}

/** Profile columns only: the avatar bytes are never read here. */
export async function getAccountProfile(db: DbExecutor, userId: string): Promise<AccountProfile | null> {
  const u = schema.users;
  const [row] = await db
    .select({ id: u.id, email: u.email, name: u.name, preferredName: u.preferredName, jobTitle: u.jobTitle, locale: u.locale, timeZone: u.timeZone, theme: u.theme, density: u.density, isSuperAdmin: u.isSuperAdmin, avatarUpdatedAt: u.avatarUpdatedAt, sessionVersion: u.sessionVersion, passwordChangedAt: u.passwordChangedAt })
    .from(u)
    .where(eq(u.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system",
    density: row.density === "compact" ? "compact" : "comfortable",
    hasAvatar: row.avatarUpdatedAt !== null,
    avatarVersion: row.avatarUpdatedAt ? row.avatarUpdatedAt.getTime() : null,
  };
}

async function audit(ac: AccountContext, action: string, diff: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  await recordAudit(ac.db, { tenantId: null, actorUserId: ac.userId, actorType: "user", action, entityType: "user", entityId: ac.userId, diff, metadata, ip: ac.ip ?? null });
}

async function current(ac: AccountContext): Promise<AccountProfile> {
  const p = await getAccountProfile(ac.db, ac.userId);
  if (!p) throw new AccountError("not_found");
  return p;
}

export async function updateProfile(ac: AccountContext, input: ProfileInput): Promise<AccountProfile> {
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) throw new AccountError("invalid_input");
  const before = await current(ac);
  const diff = diffRecords({ name: before.name, preferredName: before.preferredName, jobTitle: before.jobTitle }, parsed.data);
  if (hasChanges(diff)) {
    await ac.db.update(schema.users).set(parsed.data).where(eq(schema.users.id, ac.userId));
    await audit(ac, "profile.updated", diff);
  }
  return current(ac);
}

export async function updatePreferences(ac: AccountContext, input: PreferencesInput): Promise<{ profile: AccountProfile; changed: string[] }> {
  const parsed = preferencesInputSchema.safeParse(input);
  if (!parsed.success) throw new AccountError("invalid_input");
  const before = await current(ac);
  const next = { locale: parsed.data.locale, theme: parsed.data.theme, density: parsed.data.density, timeZone: parsed.data.timeZone };
  const diff = diffRecords({ locale: before.locale, theme: before.theme, density: before.density, timeZone: before.timeZone }, next);
  if (hasChanges(diff)) {
    await ac.db.update(schema.users).set(next).where(eq(schema.users.id, ac.userId));
    await audit(ac, "profile.preferences_updated", diff);
  }
  return { profile: await current(ac), changed: Object.keys(diff) };
}

/** Stores an already resized image (the web layer owns decoding); null removes the photo. */
export async function setAvatar(ac: AccountContext, image: { data: Buffer; contentType: string } | null): Promise<void> {
  const before = await current(ac);
  const now = ac.now ?? new Date();
  await ac.db
    .update(schema.users)
    .set(image ? { avatarData: image.data, avatarContentType: image.contentType, avatarUpdatedAt: now } : { avatarData: null, avatarContentType: null, avatarUpdatedAt: null })
    .where(eq(schema.users.id, ac.userId));
  await audit(ac, image ? "profile.avatar_updated" : "profile.avatar_removed", { avatar: { from: before.hasAvatar ? "set" : null, to: image ? "set" : null } }, image ? { bytes: image.data.length, contentType: image.contentType } : {});
}

export async function getAvatar(db: DbExecutor, userId: string): Promise<{ data: Buffer; contentType: string; updatedAt: Date } | null> {
  const u = schema.users;
  const [row] = await db.select({ data: u.avatarData, contentType: u.avatarContentType, updatedAt: u.avatarUpdatedAt }).from(u).where(eq(u.id, userId)).limit(1);
  return row?.data && row.contentType && row.updatedAt ? { data: row.data, contentType: row.contentType, updatedAt: row.updatedAt } : null;
}

/* ---------- security ---------- */

export const PASSWORD_ATTEMPTS_PER_HOUR = 5;
export const EMAIL_CHANGES_PER_HOUR = 3;

/** Fixed one-hour window over this user's own audit rows: no extra table, and the trail is the evidence. */
async function assertRate(ac: AccountContext, actions: string[], max: number) {
  const since = new Date((ac.now ?? new Date()).getTime() - 3600_000);
  const [r] = await ac.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.actorUserId, ac.userId), inArray(schema.auditLogs.action, actions), gte(schema.auditLogs.createdAt, since)));
  if ((r?.n ?? 0) >= max) throw new AccountError("rate_limited");
}

/**
 * Checks the current password and the strength of the new one, stores the hash and bumps the
 * session version so every other session ends. Returns the new version for the caller's own session.
 */
export async function changePassword(ac: AccountContext, currentPassword: string, newPassword: string): Promise<{ sessionVersion: number }> {
  await assertRate(ac, ["profile.password_changed", "profile.password_change_failed"], PASSWORD_ATTEMPTS_PER_HOUR);
  const profile = await current(ac);
  const [row] = await ac.db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, ac.userId)).limit(1);
  if (!row?.hash || !(await bcrypt.compare(currentPassword, row.hash))) {
    await audit(ac, "profile.password_change_failed", {}, { reason: "wrong_password" });
    throw new AccountError("wrong_password");
  }
  const strength = checkPassword(newPassword, { email: profile.email, name: profile.name });
  if (!strength.ok) throw new AccountError("weak_password", strength.issues);
  const hash = await bcrypt.hash(newPassword, 10);
  const [updated] = await ac.db
    .update(schema.users)
    .set({ passwordHash: hash, passwordChangedAt: ac.now ?? new Date(), sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, ac.userId))
    .returning({ sessionVersion: schema.users.sessionVersion });
  await audit(ac, "profile.password_changed", { password: { from: "***", to: "***" }, sessionVersion: { from: profile.sessionVersion, to: updated!.sessionVersion } });
  return { sessionVersion: updated!.sessionVersion };
}

export async function signOutOtherSessions(ac: AccountContext): Promise<{ sessionVersion: number }> {
  const before = await current(ac);
  const [updated] = await ac.db
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, ac.userId))
    .returning({ sessionVersion: schema.users.sessionVersion });
  await audit(ac, "profile.sessions_revoked", { sessionVersion: { from: before.sessionVersion, to: updated!.sessionVersion } });
  return { sessionVersion: updated!.sessionVersion };
}

const EMAIL_TOKEN_PREFIX = "email-change:";
export const EMAIL_CHANGE_TTL_MS = 24 * 3600_000;
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface EmailChangeMessages {
  /** Absolute URL of the confirmation page; the raw token is appended. */
  confirmUrl: (token: string) => string;
  toNew: (url: string) => { subject: string; text: string };
  toOld: (newEmail: string) => { subject: string; text: string };
}

/**
 * Starts an email change: nothing changes on the account until the new address opens the link.
 * The link goes to the new address, a notice to the old one. Any earlier pending request is replaced.
 */
export async function requestEmailChange(ac: AccountContext, rawEmail: string, sink: NotificationSink, messages: EmailChangeMessages): Promise<{ pendingEmail: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AccountError("invalid_input");
  await assertRate(ac, ["profile.email_change_requested"], EMAIL_CHANGES_PER_HOUR);
  const profile = await current(ac);
  if (email === profile.email) throw new AccountError("same_email");
  const [taken] = await ac.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (taken) throw new AccountError("email_taken");
  const raw = randomBytes(32).toString("base64url");
  const now = ac.now ?? new Date();
  await ac.db.delete(schema.verificationTokens).where(like(schema.verificationTokens.identifier, `${EMAIL_TOKEN_PREFIX}${ac.userId}:%`));
  await ac.db.insert(schema.verificationTokens).values({ identifier: `${EMAIL_TOKEN_PREFIX}${ac.userId}:${email}`, token: hashToken(raw), expires: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS) });
  const url = messages.confirmUrl(raw);
  await sink.send([email], { ...messages.toNew(url), url });
  await sink.send([profile.email], messages.toOld(email));
  await audit(ac, "profile.email_change_requested", {}, { newEmail: email });
  return { pendingEmail: email };
}

/** The address waiting for confirmation, if any. */
export async function pendingEmailChange(db: DbExecutor, userId: string, now = new Date()): Promise<{ email: string; expires: Date } | null> {
  const rows = await db.select().from(schema.verificationTokens).where(like(schema.verificationTokens.identifier, `${EMAIL_TOKEN_PREFIX}${userId}:%`));
  const live = rows.find((r) => r.expires > now);
  return live ? { email: live.identifier.slice(`${EMAIL_TOKEN_PREFIX}${userId}:`.length), expires: live.expires } : null;
}

export async function cancelEmailChange(ac: AccountContext): Promise<void> {
  const removed = await ac.db.delete(schema.verificationTokens).where(like(schema.verificationTokens.identifier, `${EMAIL_TOKEN_PREFIX}${ac.userId}:%`)).returning({ identifier: schema.verificationTokens.identifier });
  if (removed.length) await audit(ac, "profile.email_change_cancelled");
}

/** Applies a confirmed change. The token alone identifies the request (it may be opened signed out). */
export async function confirmEmailChange(db: DbExecutor, rawToken: string, now = new Date()): Promise<{ userId: string; email: string }> {
  if (!rawToken || rawToken.length > 200) throw new AccountError("invalid_token");
  const vt = schema.verificationTokens;
  const [row] = await db.select().from(vt).where(and(eq(vt.token, hashToken(rawToken)), like(vt.identifier, `${EMAIL_TOKEN_PREFIX}%`))).limit(1);
  if (!row) throw new AccountError("invalid_token");
  await db.delete(vt).where(and(eq(vt.identifier, row.identifier), eq(vt.token, row.token)));
  if (row.expires <= now) throw new AccountError("expired_token");
  const rest = row.identifier.slice(EMAIL_TOKEN_PREFIX.length);
  const userId = rest.slice(0, rest.indexOf(":"));
  const email = rest.slice(rest.indexOf(":") + 1);
  const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (taken) throw new AccountError("email_taken");
  const before = await getAccountProfile(db, userId);
  if (!before) throw new AccountError("invalid_token");
  await db.update(schema.users).set({ email, emailVerified: now }).where(eq(schema.users.id, userId));
  await recordAudit(db, { tenantId: null, actorUserId: userId, actorType: "user", action: "profile.email_changed", entityType: "user", entityId: userId, diff: { email: { from: before.email, to: email } } });
  return { userId, email };
}

/* ---------- sign-ins ---------- */

const SIGN_INS_KEPT = 50;

export async function recordSignIn(db: DbExecutor, input: { userId: string; method: string; ip?: string | null; userAgent?: string | null; now?: Date }): Promise<void> {
  await db.insert(schema.userSignIns).values({ userId: input.userId, method: input.method.slice(0, 20), ip: input.ip?.slice(0, 64) ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null, createdAt: input.now ?? new Date() });
  const keep = await db.select({ createdAt: schema.userSignIns.createdAt }).from(schema.userSignIns).where(eq(schema.userSignIns.userId, input.userId)).orderBy(desc(schema.userSignIns.createdAt)).offset(SIGN_INS_KEPT - 1).limit(1);
  if (keep[0]) await db.delete(schema.userSignIns).where(and(eq(schema.userSignIns.userId, input.userId), lt(schema.userSignIns.createdAt, keep[0].createdAt)));
}

export async function listRecentSignIns(ac: AccountContext, limit = 10) {
  return ac.db
    .select({ id: schema.userSignIns.id, method: schema.userSignIns.method, ip: schema.userSignIns.ip, userAgent: schema.userSignIns.userAgent, createdAt: schema.userSignIns.createdAt })
    .from(schema.userSignIns)
    .where(eq(schema.userSignIns.userId, ac.userId))
    .orderBy(desc(schema.userSignIns.createdAt))
    .limit(Math.min(50, Math.max(1, limit)));
}
