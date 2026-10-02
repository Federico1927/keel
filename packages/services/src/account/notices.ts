import { and, asc, eq, schema, type DbExecutor } from "@hullwise/db";
import { isTimeZone } from "@hullwise/core";
import { queueEmail, type EmailTarget, type QueuedEmail } from "../email/mailer";
import type { EmailTemplateData } from "../email/templates";
import type { ServiceContext } from "../context";

/**
 * Security notices (#52): password changed, email changed, new sign-in, access disabled. Security
 * templates (sent even to people who turned other emails off); a notice older than a day is no
 * longer useful, so it expires then like a link would.
 */
export const NOTICE_TTL_MS = 24 * 3600_000;
export type NoticeTemplate = "password_changed" | "email_changed" | "new_sign_in" | "account_disabled";

export async function queueAccountNotice<K extends NoticeTemplate>(target: EmailTarget, input: { to: string; template: K; data: EmailTemplateData[K]; locale: string | null | undefined; event: string }): Promise<QueuedEmail> {
  const now = target.now ?? new Date();
  return queueEmail(target, { ...input, expiresAt: new Date(now.getTime() + NOTICE_TTL_MS) });
}

/** The zone to write times in for a person: their own, else their first workspace's, else UTC. */
export async function userTimeZone(db: DbExecutor, userId: string): Promise<string> {
  const [row] = await db
    .select({ own: schema.users.timeZone, tenant: schema.tenants.timezone })
    .from(schema.users)
    .leftJoin(schema.tenantMemberships, and(eq(schema.tenantMemberships.userId, schema.users.id), eq(schema.tenantMemberships.isActive, true)))
    .leftJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId))
    .where(eq(schema.users.id, userId))
    .orderBy(asc(schema.tenants.name))
    .limit(1);
  const zone = row?.own ?? row?.tenant ?? "UTC";
  return isTimeZone(zone) ? zone : "UTC";
}

/** "Your access to {tenant} was disabled": sent when an admin deactivates a member (tenant-scoped log row). */
export async function sendAccessDisabledNotice(s: ServiceContext, input: { userId: string; tenantName: string; membershipId: string }): Promise<QueuedEmail | null> {
  const [user] = await s.tx.select({ email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
  if (!user) return null;
  const now = s.now ?? new Date();
  return queueAccountNotice(s, { to: user.email, template: "account_disabled", data: { tenantName: input.tenantName }, locale: user.locale, event: `access-disabled:${input.membershipId}:${now.getTime()}` });
}
