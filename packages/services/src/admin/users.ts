import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, recordAudit, schema, sql, type DbExecutor, type SQL } from "@hullwise/db";
import { PRODUCT_NAME } from "@hullwise/config";
import { queueAccountNotice } from "../account/notices";

/**
 * Users directory of the console (#48): every person across tenants, with memberships, last sign-in
 * and the super-admin flag. Actions (disable/enable, revoke sessions) run on the admin connection
 * and are audited with the super-admin as actor; passwords are never read nor set here (the
 * password reset goes through the person's own email, see `requestPasswordReset`).
 */

export class AdminUserError extends Error {
  constructor(readonly code: "not_found" | "self") {
    super(code);
    this.name = "AdminUserError";
  }
}

export const USER_SORTS = ["email", "name", "last_login", "created"] as const;
export type UserSort = (typeof USER_SORTS)[number];

export interface UserDirectoryFilters {
  q?: string;
  /** `super_admin` | `disabled` | `active` | `no_tenant` */
  kind?: string;
  tenantId?: string;
  sort?: UserSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface UserDirectoryRow {
  id: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  memberships: { tenantId: string; tenantName: string; role: string; isActive: boolean }[];
}

const isUuid = (v: string | undefined): v is string => Boolean(v && /^[0-9a-f-]{36}$/i.test(v));

export async function userDirectory(db: DbExecutor, f: UserDirectoryFilters = {}): Promise<{ rows: UserDirectoryRow[]; total: number; page: number; pageSize: number }> {
  const u = schema.users;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, f.pageSize ?? 50));
  const conds: SQL[] = [];
  const q = f.q?.trim().slice(0, 120);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(u.email, like), ilike(u.name, like), ilike(u.preferredName, like))!);
  }
  if (f.kind === "super_admin") conds.push(eq(u.isSuperAdmin, true));
  if (f.kind === "disabled") conds.push(isNotNull(u.disabledAt));
  if (f.kind === "active") conds.push(isNull(u.disabledAt));
  if (f.kind === "no_tenant") conds.push(sql`not exists (select 1 from ${schema.tenantMemberships} m where m.user_id = ${u.id})`);
  if (isUuid(f.tenantId)) conds.push(sql`exists (select 1 from ${schema.tenantMemberships} m where m.user_id = ${u.id} and m.tenant_id = ${f.tenantId}::uuid)`);
  const where = conds.length ? and(...conds) : undefined;
  const col = f.sort === "name" ? u.name : f.sort === "last_login" ? u.lastLoginAt : f.sort === "created" ? u.createdAt : u.email;
  const dir = f.dir ?? (f.sort === "last_login" || f.sort === "created" ? "desc" : "asc");
  const order = dir === "desc" ? sql`${col} desc nulls last` : sql`${col} asc nulls last`;
  const [rows, [count]] = await Promise.all([
    db.select({ id: u.id, email: u.email, name: u.name, isSuperAdmin: u.isSuperAdmin, disabledAt: u.disabledAt, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt }).from(u).where(where).orderBy(order, asc(u.email)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(u).where(where),
  ]);
  const memberships = rows.length
    ? await db
        .select({ userId: schema.tenantMemberships.userId, tenantId: schema.tenants.id, tenantName: schema.tenants.name, role: schema.tenantMemberships.role, isActive: schema.tenantMemberships.isActive })
        .from(schema.tenantMemberships)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId))
        .where(inArray(schema.tenantMemberships.userId, rows.map((r) => r.id)))
        .orderBy(asc(schema.tenants.name))
    : [];
  return { rows: rows.map((r) => ({ ...r, memberships: memberships.filter((m) => m.userId === r.id).map(({ userId: _u, ...m }) => m) })), total: count?.n ?? 0, page, pageSize };
}

export async function adminUserDetail(db: DbExecutor, userId: string) {
  if (!isUuid(userId)) return null;
  const u = schema.users;
  const [user] = await db.select({ id: u.id, email: u.email, name: u.name, preferredName: u.preferredName, jobTitle: u.jobTitle, locale: u.locale, isSuperAdmin: u.isSuperAdmin, disabledAt: u.disabledAt, disabledReason: u.disabledReason, disabledBy: u.disabledBy, lastLoginAt: u.lastLoginAt, passwordChangedAt: u.passwordChangedAt, emailVerified: u.emailVerified, sessionVersion: u.sessionVersion, createdAt: u.createdAt }).from(u).where(eq(u.id, userId)).limit(1);
  if (!user) return null;
  const [memberships, signIns, audit, disabledBy] = await Promise.all([
    db.select({ tenantId: schema.tenants.id, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug, tenantStatus: schema.tenants.status, role: schema.tenantMemberships.role, isActive: schema.tenantMemberships.isActive, since: schema.tenantMemberships.createdAt }).from(schema.tenantMemberships).innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId)).where(eq(schema.tenantMemberships.userId, userId)).orderBy(asc(schema.tenants.name)),
    db.select({ id: schema.userSignIns.id, method: schema.userSignIns.method, userAgent: schema.userSignIns.userAgent, createdAt: schema.userSignIns.createdAt }).from(schema.userSignIns).where(eq(schema.userSignIns.userId, userId)).orderBy(desc(schema.userSignIns.createdAt)).limit(10),
    db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityType, "user"), eq(schema.auditLogs.entityId, userId))).orderBy(desc(schema.auditLogs.createdAt)).limit(20),
    user.disabledBy ? db.select({ email: u.email }).from(u).where(eq(u.id, user.disabledBy)).limit(1) : Promise.resolve([]),
  ]);
  return { user, memberships, signIns, audit, disabledByEmail: disabledBy[0]?.email ?? null };
}

/**
 * Platform-wide disable: no sign-in with any method, every session ends at once (session version
 * bump), the person gets the "access disabled" security email. Enabling clears the flag only; old
 * sessions stay ended.
 */
export async function setUserDisabled(db: DbExecutor, input: { userId: string; disabled: boolean; reason?: string | null; actorUserId: string; now?: Date }): Promise<{ changed: boolean }> {
  const now = input.now ?? new Date();
  if (input.userId === input.actorUserId) throw new AdminUserError("self");
  const [user] = await db.select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale, disabledAt: schema.users.disabledAt, disabledReason: schema.users.disabledReason, sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
  if (!user) throw new AdminUserError("not_found");
  if (Boolean(user.disabledAt) === input.disabled) return { changed: false };
  const reason = input.reason?.trim().slice(0, 500) || null;
  if (input.disabled) {
    const [updated] = await db.update(schema.users).set({ disabledAt: now, disabledReason: reason, disabledBy: input.actorUserId, sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, user.id)).returning({ sessionVersion: schema.users.sessionVersion });
    await recordAudit(db, { tenantId: null, actorUserId: input.actorUserId, actorType: "super_admin", action: "user.disabled", entityType: "user", entityId: user.id, diff: { disabledAt: { from: null, to: now }, sessionVersion: { from: user.sessionVersion, to: updated!.sessionVersion } }, metadata: { reason, email: user.email } });
    await queueAccountNotice({ db, now }, { to: user.email, template: "account_disabled", data: { tenantName: PRODUCT_NAME }, locale: user.locale, event: `account-disabled:${user.id}:${now.getTime()}` });
  } else {
    await db.update(schema.users).set({ disabledAt: null, disabledReason: null, disabledBy: null }).where(eq(schema.users.id, user.id));
    await recordAudit(db, { tenantId: null, actorUserId: input.actorUserId, actorType: "super_admin", action: "user.enabled", entityType: "user", entityId: user.id, diff: { disabledAt: { from: user.disabledAt, to: null } }, metadata: { previousReason: user.disabledReason, note: reason, email: user.email } });
  }
  return { changed: true };
}

/** Ends every session of the person (they sign in again); audited. */
export async function revokeUserSessions(db: DbExecutor, input: { userId: string; actorUserId: string }): Promise<{ sessionVersion: number }> {
  const [user] = await db.select({ sessionVersion: schema.users.sessionVersion, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
  if (!user) throw new AdminUserError("not_found");
  const [updated] = await db.update(schema.users).set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, input.userId)).returning({ sessionVersion: schema.users.sessionVersion });
  await recordAudit(db, { tenantId: null, actorUserId: input.actorUserId, actorType: "super_admin", action: "user.sessions_revoked", entityType: "user", entityId: input.userId, diff: { sessionVersion: { from: user.sessionVersion, to: updated!.sessionVersion } }, metadata: { email: user.email } });
  return { sessionVersion: updated!.sessionVersion };
}
