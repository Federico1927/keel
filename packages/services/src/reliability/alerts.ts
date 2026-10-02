import { and, desc, eq, inArray, isNull, not, recordAudit, schema, sql, withTenant, type Database, type DbExecutor, type SQL, type Transaction } from "@keel/db";
import { FAILURE_ALERT_WINDOW_HOURS } from "@keel/config";
import { failureAlertSignature, windowElapsed, type FailureAlertKind } from "@keel/core";
import { MockNotificationSink } from "@keel/integrations";
import { queueEmail } from "../email/mailer";
import { appBaseUrl } from "../email/unsubscribe";
import { membersWithRoles, notifyUsers } from "../notifications";

/**
 * Platform failure alerts (#32): one row per signature (kind, tenant, job type or source). Raising
 * an alert again bumps it; the super-admins (email + the platform Slack channel, a mock until a
 * webhook is configured; in-app = the console's alerts page) and, for job failures, the tenant's
 * owners (in-app + email/Slack per their preferences) hear about it at most once per window.
 */
export type TenantTxRunner = <T>(tenantId: string, fn: (tx: Transaction) => Promise<T>) => Promise<T>;
const defaultRunner: TenantTxRunner = (tenantId, fn) => withTenant(tenantId, fn);

let platformSink: MockNotificationSink | null = null;
/** The platform's own Slack channel: a recording mock (no vendor call), shared by the process. */
export function platformAlertSink(): MockNotificationSink {
  platformSink ??= new MockNotificationSink("slack");
  return platformSink;
}

export interface RaiseAlertInput {
  kind: FailureAlertKind;
  tenantId: string | null;
  /** Job type (`sync.ads`, `tick:billing`) or integration source (`meta`). */
  subject: string;
  error?: string | null;
  now?: Date;
  meta?: Record<string, unknown>;
}

export interface RaisedAlert {
  id: string;
  occurrences: number;
  notified: boolean;
}

/** Notification type and message per alert kind: stale sources reuse the sync-delay wording. */
function messageFor(kind: FailureAlertKind, subject: string, tenantName: string | null, error: string | null, meta: Record<string, unknown>) {
  const who = tenantName ? ` · ${tenantName}` : "";
  if (kind === "sync_stale") return { type: "sync_delay", title: `${subject}${who}`, body: typeof meta.minutesLate === "number" ? `+${Math.max(1, Math.round(meta.minutesLate / 60))}h` : (error ?? "") };
  return { type: "platform_failure", title: `${subject}${who}`, body: error ?? "" };
}

export async function raisePlatformAlert(db: Database, input: RaiseAlertInput, opts: { runInTenant?: TenantTxRunner; notifyTenant?: boolean } = {}): Promise<RaisedAlert> {
  const now = input.now ?? new Date();
  const signature = failureAlertSignature(input.kind, input.tenantId, input.subject);
  const a = schema.platformAlerts;
  const reopened = sql`${a.status} = 'resolved'`;
  const [row] = await db
    .insert(a)
    .values({ tenantId: input.tenantId, signature, kind: input.kind, subject: input.subject, status: "open", occurrences: 1, lastError: input.error ?? null, firstSeenAt: now, lastSeenAt: now, meta: input.meta ?? {} })
    .onConflictDoUpdate({
      target: a.signature,
      set: {
        status: "open",
        occurrences: sql`case when ${reopened} then 1 else ${a.occurrences} + 1 end`,
        firstSeenAt: sql`case when ${reopened} then ${now} else ${a.firstSeenAt} end`,
        lastSeenAt: now,
        lastError: input.error ?? null,
        resolvedAt: null,
        resolvedBy: null,
        meta: input.meta ?? {},
      },
    })
    .returning();
  const alert = row!;
  const windowMinutes = FAILURE_ALERT_WINDOW_HOURS * 60;
  if (!windowElapsed(alert.lastNotifiedAt, windowMinutes, now)) return { id: alert.id, occurrences: alert.occurrences, notified: false };
  // claim the notification: two workers raising the same alert at once notify once
  const [claimed] = await db
    .update(a)
    .set({ lastNotifiedAt: now, notifiedCount: sql`${a.notifiedCount} + 1` })
    .where(and(eq(a.id, alert.id), alert.lastNotifiedAt ? eq(a.lastNotifiedAt, alert.lastNotifiedAt) : isNull(a.lastNotifiedAt)))
    .returning({ notifiedCount: a.notifiedCount });
  if (!claimed) return { id: alert.id, occurrences: alert.occurrences, notified: false };
  const [tenant] = input.tenantId ? await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, input.tenantId)).limit(1) : [];
  const msg = messageFor(input.kind, input.subject, tenant?.name ?? null, input.error ?? null, input.meta ?? {});
  const url = `${appBaseUrl()}/admin/alerts?status=open`;
  const supers = await db.select({ email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(and(eq(schema.users.isSuperAdmin, true), isNull(schema.users.disabledAt)));
  for (const s of supers) await queueEmail({ db, now }, { to: s.email, template: "notification", data: { title: msg.title, body: msg.body || null, url, type: msg.type }, locale: s.locale ?? "en", category: "platform_failure", event: `platform_alert:${alert.id}:${claimed.notifiedCount}` });
  await platformAlertSink().send([], { subject: msg.title, text: msg.body, url });
  if (input.kind === "job_failure" && input.tenantId && opts.notifyTenant !== false) {
    const tenantId = input.tenantId;
    await (opts.runInTenant ?? defaultRunner)(tenantId, async (tx) => {
      const ctx = { tenantId, tx, actor: { type: "system" as const, userId: null }, now };
      await notifyUsers(ctx, { userIds: await membersWithRoles(ctx, ["owner"]), type: "platform_failure", title: input.subject, body: input.error ?? null, link: "/integrations", severity: "critical", metadata: { signature, occurrences: alert.occurrences } });
    });
  }
  return { id: alert.id, occurrences: alert.occurrences, notified: true };
}

/** Closes the open alert of a signature (the job or source recovered, or a super-admin closed it). */
export async function resolvePlatformAlert(db: DbExecutor, signature: string, opts: { by?: string; now?: Date } = {}): Promise<boolean> {
  const r = await db.update(schema.platformAlerts).set({ status: "resolved", resolvedAt: opts.now ?? new Date(), resolvedBy: opts.by ?? "auto" }).where(and(eq(schema.platformAlerts.signature, signature), eq(schema.platformAlerts.status, "open")));
  return (r.rowCount ?? 0) > 0;
}

/** Stale-source alerts of a tenant whose source is no longer stale close by themselves (the watchdog tick calls this). */
export async function resolveRecoveredSourceAlerts(db: DbExecutor, tenantId: string, staleSources: readonly string[], now = new Date()): Promise<number> {
  const a = schema.platformAlerts;
  const r = await db.update(a).set({ status: "resolved", resolvedAt: now, resolvedBy: "auto" }).where(and(eq(a.tenantId, tenantId), eq(a.kind, "sync_stale"), eq(a.status, "open"), ...(staleSources.length ? [not(inArray(a.subject, [...staleSources]))] : [])));
  return r.rowCount ?? 0;
}

export interface AlertFilters {
  status?: string;
  kind?: string;
  tenantId?: string;
}

/** The console's alerts page: newest first, with open counts per kind. */
export async function listPlatformAlerts(db: DbExecutor, f: AlertFilters = {}) {
  const a = schema.platformAlerts;
  const conds: SQL[] = [];
  if (f.status === "open" || f.status === "resolved") conds.push(eq(a.status, f.status));
  if (f.kind === "job_failure" || f.kind === "sync_stale") conds.push(eq(a.kind, f.kind));
  if (f.tenantId === "platform") conds.push(isNull(a.tenantId));
  else if (f.tenantId && /^[0-9a-f-]{36}$/i.test(f.tenantId)) conds.push(eq(a.tenantId, f.tenantId));
  const [rows, [counts]] = await Promise.all([
    db.select({ alert: a, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(a).leftJoin(schema.tenants, eq(schema.tenants.id, a.tenantId)).where(conds.length ? and(...conds) : undefined).orderBy(sql`case when ${a.status} = 'open' then 0 else 1 end`, desc(a.lastSeenAt)).limit(200),
    db.select({ open: sql<number>`count(*) filter (where ${a.status} = 'open')::int`, jobs: sql<number>`count(*) filter (where ${a.status} = 'open' and ${a.kind} = 'job_failure')::int`, stale: sql<number>`count(*) filter (where ${a.status} = 'open' and ${a.kind} = 'sync_stale')::int` }).from(a),
  ]);
  return { rows, counts: counts ?? { open: 0, jobs: 0, stale: 0 } };
}

/** A super-admin closes an alert by hand (audited on the tenant, or on the platform). */
export async function closePlatformAlert(db: Database, alertId: string, actorUserId: string, now = new Date()): Promise<boolean> {
  const [alert] = await db.select().from(schema.platformAlerts).where(eq(schema.platformAlerts.id, alertId)).limit(1);
  if (!alert || alert.status !== "open") return false;
  await resolvePlatformAlert(db, alert.signature, { by: actorUserId, now });
  await recordAudit(db, { tenantId: alert.tenantId, actorUserId, actorType: "super_admin", action: "admin.alert_resolved", entityType: "platform_alert", entityId: alert.id, diff: { status: { from: "open", to: "resolved" } }, metadata: { signature: alert.signature, occurrences: alert.occurrences } });
  return true;
}
