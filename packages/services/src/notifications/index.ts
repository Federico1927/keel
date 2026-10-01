import { and, desc, eq, inArray, isNotNull, isNull, schema, sql, type SQL } from "@keel/db";
import { NOTIFICATION_CHANNELS, resolveNotificationChannels, type NotificationChannel } from "@keel/config";
import type { ServiceContext } from "../context";
import { getNotificationSinks } from "../integrations/factory";
import type { EmailTemplateData } from "./email-templates";
import { appBaseUrl, sendTenantEmail } from "./mailer";
import { preferenceOverridesFor } from "./preferences";

export * from "./email-templates";
export * from "./mailer";
export * from "./preferences";
export * from "./mentions";
export * from "./system";
export * from "./supplier";

export interface NotifyInput {
  userIds: string[];
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: "info" | "warning" | "critical" | "success";
  metadata?: Record<string, unknown>;
  /** Skip if the same type+link was sent to the user within this many minutes (any channel). */
  antiSpamMinutes?: number;
  /** Email body for types with their own template; otherwise the generic notification template. */
  email?: { template: "mention"; data: Omit<EmailTemplateData["mention"], "url"> };
}

/** Absolute URL of an in-app link (`/orders/…` is relative to the tenant, `/t/…` already carries it). */
export function absoluteAppLink(link: string | null | undefined, tenantSlug: string): string | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  return `${appBaseUrl()}${link.startsWith("/t/") ? link : `/t/${tenantSlug}${link.startsWith("/") ? link : `/${link}`}`}`;
}

/**
 * Delivers one event to users on the channels each of them chose for the type (preferences,
 * enforced here, the only write path for notifications). Every delivery leaves one row: in-app
 * rows show in the bell and the inbox; rows with the in-app channel off only record the outbound
 * deliveries (and feed the anti-spam check). Email goes through the templates and the suppression
 * list; Slack posts once per event to the tenant's channel when any recipient wants it.
 * Returns the number of in-app notifications written.
 */
export async function notifyUsers(ctx: ServiceContext, input: NotifyInput): Promise<number> {
  const now = ctx.now ?? new Date();
  const ids = [...new Set(input.userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const overrides = await preferenceOverridesFor(ctx, ids, input.type);
  const recipients: { userId: string; channels: Record<NotificationChannel, boolean> }[] = [];
  for (const userId of ids) {
    if (input.antiSpamMinutes) {
      const since = new Date(now.getTime() - input.antiSpamMinutes * 60_000);
      const [dup] = await ctx.tx
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), eq(schema.notifications.type, input.type), input.link ? eq(schema.notifications.link, input.link) : isNull(schema.notifications.link), sql`${schema.notifications.createdAt} >= ${since}`))
        .limit(1);
      if (dup) continue;
    }
    const channels = resolveNotificationChannels(input.type, overrides.get(userId));
    if (NOTIFICATION_CHANNELS.some((c) => channels[c])) recipients.push({ userId, channels });
  }
  if (!recipients.length) return 0;

  const needEmail = recipients.some((r) => r.channels.email);
  const needSlack = recipients.some((r) => r.channels.slack);
  const [tenant] = await ctx.tx.select({ slug: schema.tenants.slug, name: schema.tenants.name, defaultLocale: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const url = absoluteAppLink(input.link, tenant?.slug ?? "");
  const sinks = needEmail || needSlack ? await getNotificationSinks(ctx) : null;
  let slackOutcome: string | null = null;
  if (needSlack && sinks) {
    if (!sinks.slack) slackOutcome = "not_configured";
    else
      try {
        await sinks.slack.send([], { subject: input.title, text: input.body ?? "", url: url ?? undefined });
        slackOutcome = sinks.mock.slack ? "mock" : "sent";
      } catch (e) {
        slackOutcome = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      }
  }
  const people = needEmail ? await ctx.tx.select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(inArray(schema.users.id, recipients.filter((r) => r.channels.email).map((r) => r.userId))) : [];

  let written = 0;
  for (const r of recipients) {
    const delivered: Record<string, string> = {};
    if (r.channels.email && sinks) {
      const person = people.find((p) => p.id === r.userId);
      if (person) {
        const locale = person.locale ?? tenant?.defaultLocale ?? "en";
        const res = input.email
          ? await sendTenantEmail(ctx, { to: person.email, template: "mention", data: { ...input.email.data, url: url ?? appBaseUrl() }, locale, category: input.type, sink: sinks.email, mock: sinks.mock.email })
          : await sendTenantEmail(ctx, { to: person.email, template: "notification", data: { title: input.title, body: input.body ?? null, url, type: input.type }, locale, category: input.type, sink: sinks.email, mock: sinks.mock.email });
        delivered.email = res.outcome;
      }
    }
    if (r.channels.slack && slackOutcome) delivered.slack = slackOutcome;
    await ctx.tx.insert(schema.notifications).values({ tenantId: ctx.tenantId, userId: r.userId, type: input.type, title: input.title, body: input.body ?? null, link: input.link ?? null, severity: input.severity ?? "info", metadata: input.metadata ?? {}, inApp: r.channels.in_app, readAt: r.channels.in_app ? null : now, delivered, createdAt: now });
    if (r.channels.in_app) written++;
  }
  return written;
}

const mine = (ctx: ServiceContext, userId: string) => and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), eq(schema.notifications.inApp, true));

export async function unreadCount(ctx: ServiceContext, userId: string): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(mine(ctx, userId), isNull(schema.notifications.readAt)));
  return r?.n ?? 0;
}

export async function listNotifications(ctx: ServiceContext, userId: string, limit = 20) {
  return ctx.tx.select().from(schema.notifications).where(mine(ctx, userId)).orderBy(desc(schema.notifications.createdAt)).limit(limit);
}

export async function markAllRead(ctx: ServiceContext, userId: string): Promise<void> {
  await ctx.tx.update(schema.notifications).set({ readAt: ctx.now ?? new Date() }).where(and(mine(ctx, userId), isNull(schema.notifications.readAt)));
}

export interface NotificationFilters {
  status?: "unread" | "read";
  type?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
}

/** The notifications page: the user's in-app notifications with filters, server-side pagination and counts per type. */
export async function listNotificationsPage(ctx: ServiceContext, userId: string, f: NotificationFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(100, f.pageSize ?? 30);
  const conds: SQL[] = [mine(ctx, userId)!];
  if (f.status === "unread") conds.push(isNull(schema.notifications.readAt));
  if (f.status === "read") conds.push(isNotNull(schema.notifications.readAt));
  if (f.severity) conds.push(eq(schema.notifications.severity, f.severity));
  const typeConds = [...conds];
  if (f.type) conds.push(eq(schema.notifications.type, f.type));
  const where = and(...conds);
  const [rows, [count], types, [unread]] = await Promise.all([
    ctx.tx.select().from(schema.notifications).where(where).orderBy(desc(schema.notifications.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(where),
    ctx.tx.select({ type: schema.notifications.type, n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(...typeConds)).groupBy(schema.notifications.type).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(mine(ctx, userId), isNull(schema.notifications.readAt))),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize, types, unread: unread?.n ?? 0 };
}

/** Marks some of the user's notifications read or unread; other users' ids are ignored. */
export async function setNotificationsRead(ctx: ServiceContext, userId: string, ids: string[], read: boolean): Promise<number> {
  if (!ids.length) return 0;
  const rows = await ctx.tx.update(schema.notifications).set({ readAt: read ? (ctx.now ?? new Date()) : null }).where(and(mine(ctx, userId), inArray(schema.notifications.id, ids))).returning({ id: schema.notifications.id });
  return rows.length;
}

