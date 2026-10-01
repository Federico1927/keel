import { and, desc, eq, isNull, schema, sql } from "@keel/db";
import type { ServiceContext } from "../context";

export interface NotifyInput {
  userIds: string[];
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: "info" | "warning" | "critical" | "success";
  metadata?: Record<string, unknown>;
  /** Skip if the same type+link was sent to the user within this many minutes. */
  antiSpamMinutes?: number;
}

export async function notifyUsers(ctx: ServiceContext, input: NotifyInput): Promise<number> {
  let written = 0;
  const now = ctx.now ?? new Date();
  for (const userId of new Set(input.userIds)) {
    if (input.antiSpamMinutes) {
      const since = new Date(now.getTime() - input.antiSpamMinutes * 60_000);
      const [dup] = await ctx.tx
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), eq(schema.notifications.type, input.type), input.link ? eq(schema.notifications.link, input.link) : isNull(schema.notifications.link), sql`${schema.notifications.createdAt} >= ${since}`))
        .limit(1);
      if (dup) continue;
    }
    await ctx.tx.insert(schema.notifications).values({ tenantId: ctx.tenantId, userId, type: input.type, title: input.title, body: input.body ?? null, link: input.link ?? null, severity: input.severity ?? "info", metadata: input.metadata ?? {}, createdAt: now });
    written++;
  }
  return written;
}

export async function unreadCount(ctx: ServiceContext, userId: string): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return r?.n ?? 0;
}

export async function listNotifications(ctx: ServiceContext, userId: string, limit = 20) {
  return ctx.tx.select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId))).orderBy(desc(schema.notifications.createdAt)).limit(limit);
}

export async function markAllRead(ctx: ServiceContext, userId: string): Promise<void> {
  await ctx.tx.update(schema.notifications).set({ readAt: ctx.now ?? new Date() }).where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
}
