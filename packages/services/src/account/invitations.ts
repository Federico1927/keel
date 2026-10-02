import bcrypt from "bcryptjs";
import { and, desc, eq, inArray, or, gte, recordAudit, schema, sql, type Database, type DbExecutor, type Transaction } from "@keel/db";
import { canManageRole, isLocale, type TenantRole } from "@keel/config";
import { checkPassword, normalizeEmail } from "@keel/core";
import type { ServiceContext } from "../context";
import { queueEmail, type QueueOutcome } from "../email/mailer";
import { appBaseUrl } from "../email/unsubscribe";
import { AccountError } from "./errors";
import { hashAccountToken, isWellFormedToken, newAccountToken, sameTokenHash } from "./tokens";

/**
 * Invitations (#52). Inviting a person creates an `invitations` row (tenant, email, role, inviter,
 * SHA-256 of a 32-byte token, 7-day expiry, status) and emails the accept link; nothing else is
 * created until the person accepts. Owners and admins list, resend (new token, new expiry) and
 * revoke them inside the tenant transaction (RLS). The accept page works before any tenant context:
 * it finds the row by token hash through the admin connection (the auth layer), and the tenant the
 * membership is added to is always the invitation's own.
 */
export const INVITATION_TTL_DAYS = 7;
const TTL_MS = INVITATION_TTL_DAYS * 24 * 3600_000;
/** Invitations one tenant can send per hour (resends included): a stolen admin session cannot turn Keel into a spam relay. */
export const INVITATIONS_PER_HOUR = 30;

export type InvitationState = "pending" | "expired" | "accepted" | "revoked";
type InvitationRow = typeof schema.invitations.$inferSelect;

export function invitationState(row: Pick<InvitationRow, "status" | "expiresAt">, now = new Date()): InvitationState {
  if (row.status === "accepted" || row.status === "revoked") return row.status;
  return row.expiresAt <= now ? "expired" : "pending";
}

export const inviteUrl = (raw: string) => `${appBaseUrl()}/invite/${raw}`;

/** Who appears in the audit trail; the web layer passes impersonation explicitly. */
export interface AuditAs {
  actorUserId: string | null;
  actorType: "user" | "impersonation" | "super_admin" | "system";
  impersonatedBy?: string | null;
}
const auditAsOf = (s: ServiceContext, as?: AuditAs): AuditAs => as ?? { actorUserId: s.actor.userId, actorType: s.actor.userId ? "user" : "system" };

export interface InviteInput {
  email: string;
  role: TenantRole;
  /** Optional name to pre-fill on the accept page. */
  name?: string | null;
  inviterName: string;
  tenantName: string;
  tenantLocale: string;
}

export interface InvitationListItem {
  id: string;
  email: string;
  role: TenantRole;
  name: string | null;
  state: InvitationState;
  expiresAt: Date;
  lastSentAt: Date;
  sendCount: number;
  invitedByName: string | null;
  createdAt: Date;
}

async function assertInviteRate(s: ServiceContext, now: Date) {
  const since = new Date(now.getTime() - 3600_000);
  const [r] = await s.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.tenantId, s.tenantId), inArray(schema.auditLogs.action, ["invitation.sent", "invitation.resent"]), gte(schema.auditLogs.createdAt, since)));
  if ((r?.n ?? 0) >= INVITATIONS_PER_HOUR) throw new AccountError("rate_limited");
}

async function sendInviteEmail(s: ServiceContext, inv: { id: string; email: string; role: string; tenantLocale: string }, raw: string, names: { inviterName: string; tenantName: string }, expiresAt: Date, sendNo: number): Promise<QueueOutcome> {
  const [invitee] = await s.tx.select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.email, inv.email)).limit(1);
  const q = await queueEmail(s, { to: inv.email, template: "invite", data: { tenantName: names.tenantName, inviterName: names.inviterName, role: inv.role, url: inviteUrl(raw), days: INVITATION_TTL_DAYS }, locale: invitee?.locale ?? inv.tenantLocale, event: `invite:${inv.id}:${sendNo}`, expiresAt });
  return q.outcome;
}

/** Creates (or replaces) the pending invitation for an address and emails it. */
export async function createInvitation(s: ServiceContext, input: InviteInput, opts: { auditAs?: AuditAs; actorRole?: TenantRole } = {}): Promise<{ id: string; email: string; delivery: QueueOutcome }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new AccountError("invalid_input");
  if (opts.actorRole && !canManageRole(opts.actorRole, input.role)) throw new AccountError("forbidden");
  const now = s.now ?? new Date();
  await assertInviteRate(s, now);
  const [member] = await s.tx
    .select({ id: schema.tenantMemberships.id })
    .from(schema.tenantMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId))
    .where(and(eq(schema.tenantMemberships.tenantId, s.tenantId), eq(schema.users.email, email), eq(schema.tenantMemberships.isActive, true)))
    .limit(1);
  if (member) throw new AccountError("already_member");
  const as = auditAsOf(s, opts.auditAs);
  // one live invitation per address: an earlier pending one stops working
  const replaced = await s.tx
    .update(schema.invitations)
    .set({ status: "revoked", revokedAt: now, revokedBy: as.actorUserId, updatedAt: now })
    .where(and(eq(schema.invitations.tenantId, s.tenantId), eq(schema.invitations.email, email), eq(schema.invitations.status, "pending")))
    .returning({ id: schema.invitations.id });
  for (const r of replaced) await recordAudit(s.tx, { tenantId: s.tenantId, ...as, action: "invitation.revoked", entityType: "invitation", entityId: r.id, diff: { status: { from: "pending", to: "revoked" } }, metadata: { email, reason: "replaced" } });
  const token = newAccountToken();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const name = input.name?.trim() ? input.name.trim().slice(0, 120) : null;
  const [row] = await s.tx
    .insert(schema.invitations)
    .values({ tenantId: s.tenantId, email, role: input.role, name, invitedBy: as.actorUserId, tokenHash: token.hash, expiresAt, status: "pending", sendCount: 1, lastSentAt: now, createdAt: now, updatedAt: now })
    .returning({ id: schema.invitations.id });
  const delivery = await sendInviteEmail(s, { id: row!.id, email, role: input.role, tenantLocale: input.tenantLocale }, token.raw, input, expiresAt, 1);
  await recordAudit(s.tx, { tenantId: s.tenantId, ...as, action: "invitation.sent", entityType: "invitation", entityId: row!.id, diff: { status: { from: null, to: "pending" }, role: { from: null, to: input.role } }, metadata: { email, expiresAt: expiresAt.toISOString(), email_delivery: delivery } });
  return { id: row!.id, email, delivery };
}

async function pendingRow(s: ServiceContext, id: string, actorRole?: TenantRole): Promise<InvitationRow> {
  const [row] = await s.tx.select().from(schema.invitations).where(and(eq(schema.invitations.id, id), eq(schema.invitations.tenantId, s.tenantId))).limit(1);
  if (!row) throw new AccountError("not_found");
  if (row.status !== "pending") throw new AccountError("not_pending");
  if (actorRole && !canManageRole(actorRole, row.role)) throw new AccountError("forbidden");
  return row;
}

/** New token and a fresh 7-day expiry (the old link stops working: only hashes are kept). */
export async function resendInvitation(s: ServiceContext, id: string, names: { inviterName: string; tenantName: string; tenantLocale: string }, opts: { auditAs?: AuditAs; actorRole?: TenantRole } = {}): Promise<{ delivery: QueueOutcome }> {
  const now = s.now ?? new Date();
  const row = await pendingRow(s, id, opts.actorRole);
  await assertInviteRate(s, now);
  const token = newAccountToken();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const sendNo = row.sendCount + 1;
  await s.tx.update(schema.invitations).set({ tokenHash: token.hash, expiresAt, sendCount: sendNo, lastSentAt: now, updatedAt: now }).where(eq(schema.invitations.id, row.id));
  const delivery = await sendInviteEmail(s, { id: row.id, email: row.email, role: row.role, tenantLocale: names.tenantLocale }, token.raw, names, expiresAt, sendNo);
  await recordAudit(s.tx, { tenantId: s.tenantId, ...auditAsOf(s, opts.auditAs), action: "invitation.resent", entityType: "invitation", entityId: row.id, diff: { expiresAt: { from: row.expiresAt.toISOString(), to: expiresAt.toISOString() } }, metadata: { email: row.email, sendCount: sendNo, email_delivery: delivery } });
  return { delivery };
}

export async function revokeInvitation(s: ServiceContext, id: string, opts: { auditAs?: AuditAs; actorRole?: TenantRole } = {}): Promise<void> {
  const now = s.now ?? new Date();
  const row = await pendingRow(s, id, opts.actorRole);
  const as = auditAsOf(s, opts.auditAs);
  await s.tx.update(schema.invitations).set({ status: "revoked", revokedAt: now, revokedBy: as.actorUserId, updatedAt: now }).where(eq(schema.invitations.id, row.id));
  await recordAudit(s.tx, { tenantId: s.tenantId, ...as, action: "invitation.revoked", entityType: "invitation", entityId: row.id, diff: { status: { from: "pending", to: "revoked" } }, metadata: { email: row.email } });
}

/** Pending and expired invitations, plus the ones revoked in the last 30 days (accepted ones are members now). */
export async function listInvitations(s: ServiceContext, limit = 50): Promise<InvitationListItem[]> {
  const now = s.now ?? new Date();
  const i = schema.invitations;
  const rows = await s.tx
    .select({ id: i.id, email: i.email, role: i.role, name: i.name, status: i.status, expiresAt: i.expiresAt, lastSentAt: i.lastSentAt, sendCount: i.sendCount, createdAt: i.createdAt, invitedByName: schema.users.name })
    .from(i)
    .leftJoin(schema.users, eq(schema.users.id, i.invitedBy))
    .where(and(eq(i.tenantId, s.tenantId), or(eq(i.status, "pending"), and(eq(i.status, "revoked"), gte(i.revokedAt, new Date(now.getTime() - 30 * 24 * 3600_000))))))
    .orderBy(desc(i.lastSentAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map(({ status, ...r }) => ({ ...r, state: invitationState({ status, expiresAt: r.expiresAt }, now) }));
}

/* ---------- accept (auth layer, admin connection) ---------- */

export interface InvitationView {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  email: string;
  role: TenantRole;
  name: string | null;
  inviterName: string | null;
  expiresAt: Date;
  state: InvitationState;
  /** The account that already uses the invited address, if any: it signs in instead of signing up. */
  existingUserId: string | null;
}

async function rowByToken(db: DbExecutor, raw: string): Promise<InvitationRow | null> {
  if (!isWellFormedToken(raw)) return null;
  const hash = hashAccountToken(raw);
  const [row] = await db.select().from(schema.invitations).where(eq(schema.invitations.tokenHash, hash)).limit(1);
  return row && sameTokenHash(row.tokenHash, hash) ? row : null;
}

export async function findInvitationByToken(db: DbExecutor, raw: string, now = new Date()): Promise<InvitationView | null> {
  const row = await rowByToken(db, raw);
  if (!row) return null;
  const [tenant] = await db.select({ slug: schema.tenants.slug, name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, row.tenantId)).limit(1);
  if (!tenant) return null;
  const [inviter] = row.invitedBy ? await db.select({ name: schema.users.name, preferredName: schema.users.preferredName }).from(schema.users).where(eq(schema.users.id, row.invitedBy)).limit(1) : [];
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, row.email)).limit(1);
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    email: row.email,
    role: row.role,
    name: row.name,
    inviterName: inviter?.preferredName?.trim() || inviter?.name || null,
    expiresAt: row.expiresAt,
    state: invitationState(row, now),
    existingUserId: existing?.id ?? null,
  };
}

function assertUsable(row: InvitationRow | null, now: Date): asserts row is InvitationRow {
  if (!row) throw new AccountError("invalid_token");
  const state = invitationState(row, now);
  if (state === "expired") throw new AccountError("expired_token");
  if (state === "accepted") throw new AccountError("used_token");
  if (state === "revoked") throw new AccountError("revoked_token");
}

/** Marks the invitation used (single use even under concurrent requests) and adds the membership of the invitation's own tenant. */
async function consume(tx: Transaction, row: InvitationRow, userId: string, now: Date): Promise<void> {
  const [claimed] = await tx
    .update(schema.invitations)
    .set({ status: "accepted", acceptedAt: now, acceptedUserId: userId, updatedAt: now })
    .where(and(eq(schema.invitations.id, row.id), eq(schema.invitations.status, "pending"), eq(schema.invitations.tokenHash, row.tokenHash)))
    .returning({ id: schema.invitations.id });
  if (!claimed) throw new AccountError("used_token");
  await tx
    .insert(schema.tenantMemberships)
    .values({ tenantId: row.tenantId, userId, role: row.role })
    .onConflictDoUpdate({ target: [schema.tenantMemberships.tenantId, schema.tenantMemberships.userId], set: { role: row.role, isActive: true, updatedAt: now } });
}

export interface AcceptNewUserInput {
  name: string;
  preferredName?: string | null;
  /** null: no password, the person signs in with email links. */
  password: string | null;
  privacyAccepted: boolean;
  locale?: string | null;
  ip?: string | null;
}

/**
 * First access: creates the account (email verified by the token itself), the membership and marks
 * the invitation used, in one transaction; then the welcome email. Returns what the caller needs to
 * sign the person in.
 */
export async function acceptInvitationAsNewUser(db: Database, raw: string, input: AcceptNewUserInput, now = new Date()): Promise<{ userId: string; tenantSlug: string; sessionVersion: number }> {
  const name = input.name.trim().slice(0, 120);
  const preferredName = input.preferredName?.trim() ? input.preferredName.trim().slice(0, 60) : null;
  if (!name) throw new AccountError("invalid_input");
  if (!input.privacyAccepted) throw new AccountError("privacy_required");
  return db.transaction(async (tx) => {
    const row = await rowByToken(tx, raw);
    assertUsable(row, now);
    const [existing] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, row.email)).limit(1);
    if (existing) throw new AccountError("account_exists");
    let passwordHash: string | null = null;
    if (input.password !== null) {
      const strength = checkPassword(input.password, { email: row.email, name });
      if (!strength.ok) throw new AccountError("weak_password", strength.issues);
      passwordHash = await bcrypt.hash(input.password, 10);
    }
    const [user] = await tx
      .insert(schema.users)
      .values({ email: row.email, name, preferredName, passwordHash, emailVerified: now, privacyAcceptedAt: now, passwordChangedAt: passwordHash ? now : null, locale: isLocale(input.locale) ? input.locale : null })
      .returning({ id: schema.users.id, sessionVersion: schema.users.sessionVersion });
    await consume(tx, row, user!.id, now);
    const [tenant] = await tx.select({ slug: schema.tenants.slug, name: schema.tenants.name, locale: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.id, row.tenantId)).limit(1);
    const s: ServiceContext = { tenantId: row.tenantId, tx, actor: { type: "user", userId: user!.id }, now };
    await recordAudit(tx, { tenantId: row.tenantId, actorUserId: user!.id, actorType: "user", action: "invitation.accepted", entityType: "invitation", entityId: row.id, diff: { status: { from: "pending", to: "accepted" } }, metadata: { email: row.email, role: row.role, newAccount: true, password: passwordHash ? "set" : "email_link" }, ip: input.ip ?? null });
    await recordAudit(tx, { tenantId: null, actorUserId: user!.id, actorType: "user", action: "account.created", entityType: "user", entityId: user!.id, diff: { email: { from: null, to: row.email } }, metadata: { via: "invitation", privacyAccepted: now.toISOString() }, ip: input.ip ?? null });
    const base = `${appBaseUrl()}/t/${tenant!.slug}`;
    await queueEmail(s, { to: row.email, template: "welcome", data: { name: preferredName ?? name, tenantName: tenant!.name, dashboardUrl: base, profileUrl: `${base}/profile`, guideUrl: row.role === "owner" ? `${base}/integrations/guide/shopify` : null }, locale: isLocale(input.locale) ? input.locale : tenant!.locale, event: `welcome:${user!.id}` });
    return { userId: user!.id, tenantSlug: tenant!.slug, sessionVersion: user!.sessionVersion };
  });
}

/** An existing account accepts after signing in: the invited address must be the account's own. */
export async function acceptInvitationAsUser(db: Database, raw: string, userId: string, opts: { ip?: string | null; now?: Date } = {}): Promise<{ tenantSlug: string }> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await rowByToken(tx, raw);
    assertUsable(row, now);
    const [user] = await tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new AccountError("not_found");
    if (normalizeEmail(user.email) !== row.email) throw new AccountError("email_mismatch");
    await consume(tx, row, userId, now);
    await recordAudit(tx, { tenantId: row.tenantId, actorUserId: userId, actorType: "user", action: "invitation.accepted", entityType: "invitation", entityId: row.id, diff: { status: { from: "pending", to: "accepted" } }, metadata: { email: row.email, role: row.role, newAccount: false }, ip: opts.ip ?? null });
    const [tenant] = await tx.select({ slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, row.tenantId)).limit(1);
    return { tenantSlug: tenant!.slug };
  });
}

/** Live pending invitations of a tenant, optionally for one role (console checklist). */
export async function pendingInvitationCount(db: DbExecutor, tenantId: string, role?: TenantRole, now = new Date()): Promise<number> {
  const i = schema.invitations;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(i)
    .where(and(eq(i.tenantId, tenantId), eq(i.status, "pending"), gte(i.expiresAt, now), ...(role ? [eq(i.role, role)] : [])));
  return r?.n ?? 0;
}
