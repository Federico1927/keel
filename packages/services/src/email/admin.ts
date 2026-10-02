import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, recordAudit, schema, sql, type DbExecutor, type SQL } from "@hullwise/db";
import { emailAddressHashes } from "@hullwise/integrations";
import { emailSettings } from "./provider";
import { queueEmail, type QueuedEmail } from "./mailer";

/** Super-admin console (issue #51): provider status, last-7-days counts, the log with filters, a test send. */

export interface EmailLogFilters {
  status?: string;
  template?: string;
  /** A tenant id, or `platform` for emails outside any tenant. */
  tenant?: string;
  /** Full address: matched by hash, never stored or shown in clear. */
  recipient?: string;
  page?: number;
  pageSize?: number;
}

export async function emailStats(db: DbExecutor, now = new Date(), days = 7): Promise<Record<"total" | "sent" | "delivered" | "bounced" | "complained" | "failed" | "suppressed" | "queued", number>> {
  const since = new Date(now.getTime() - days * 864e5);
  const rows = await db.select({ status: schema.emailMessages.status, n: sql<number>`count(*)::int` }).from(schema.emailMessages).where(gte(schema.emailMessages.createdAt, since)).groupBy(schema.emailMessages.status);
  const by = (...s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { total: by(...rows.map((r) => r.status)), sent: by("sent", "delivered", "delivery_delayed", "bounced", "complained"), delivered: by("delivered"), bounced: by("bounced"), complained: by("complained"), failed: by("failed", "expired"), suppressed: by("suppressed"), queued: by("queued", "sending") };
}

export async function listEmailLog(db: DbExecutor, f: EmailLogFilters = {}) {
  const m = schema.emailMessages;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(100, f.pageSize ?? 50);
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(m.status, f.status));
  if (f.template) conds.push(eq(m.template, f.template));
  if (f.tenant === "platform") conds.push(isNull(m.tenantId));
  else if (f.tenant && /^[0-9a-f-]{36}$/i.test(f.tenant)) conds.push(eq(m.tenantId, f.tenant));
  if (f.recipient?.includes("@")) conds.push(inArray(m.recipientHash, emailAddressHashes(f.recipient)));
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [count]] = await Promise.all([
    db
      .select({ id: m.id, createdAt: m.createdAt, template: m.template, category: m.category, kind: m.kind, recipientMasked: m.recipientMasked, locale: m.locale, status: m.status, provider: m.provider, providerMessageId: m.providerMessageId, attempts: m.attempts, lastErrorCode: m.lastErrorCode, lastError: m.lastError, sentAt: m.sentAt, deliveredAt: m.deliveredAt, tenantId: m.tenantId, tenantName: schema.tenants.name })
      .from(m)
      .leftJoin(schema.tenants, eq(schema.tenants.id, m.tenantId))
      .where(where)
      .orderBy(desc(m.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(m).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

/** "Send test email" from the console: a platform email to any address, audited. */
export async function sendTestEmail(db: DbExecutor, input: { to: string; locale: string | null; actorUserId: string; now?: Date }): Promise<QueuedEmail> {
  const now = input.now ?? new Date();
  const settings = emailSettings();
  const r = await queueEmail({ db, now }, { to: input.to, template: "test", data: { provider: settings.provider, sentAt: now }, locale: input.locale, event: `test:${randomUUID()}` });
  await recordAudit(db, { tenantId: null, actorUserId: input.actorUserId, actorType: "super_admin", action: "email.test_sent", entityType: "email_message", entityId: r.id, diff: {}, metadata: { provider: settings.provider, outcome: r.outcome } });
  return r;
}
