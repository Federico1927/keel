import { and, desc, eq, inArray, isNull, schema, sql, type SQL } from "@keel/db";
import type { ServiceContext } from "../context";

export const MENTION_ENTITY_TYPES = ["order", "purchase_order", "return"] as const;
export type MentionEntityType = (typeof MENTION_ENTITY_TYPES)[number];

/** One inbox row per mentioned user; called by every note service that parses mentions. */
export async function recordMentions(ctx: ServiceContext, input: { userIds: string[]; entityType: MentionEntityType; entityId: string; entityLabel: string; noteId: string | null; body: string; link: string }): Promise<void> {
  const ids = [...new Set(input.userIds)];
  if (!ids.length) return;
  const excerpt = input.body.length > 280 ? `${input.body.slice(0, 277)}…` : input.body;
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.mentions).values(ids.map((userId) => ({ tenantId: ctx.tenantId, userId, authorId: ctx.actor.userId, entityType: input.entityType, entityId: input.entityId, entityLabel: input.entityLabel, noteId: input.noteId, excerpt, link: input.link, createdAt: now })));
}

/** "My mentions": notes on orders, purchase orders and returns that mention the user. */
export async function listMentions(ctx: ServiceContext, userId: string, f: { status?: "unread" | "read"; entityType?: string; page?: number; pageSize?: number } = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(100, f.pageSize ?? 30);
  const conds: SQL[] = [eq(schema.mentions.tenantId, ctx.tenantId), eq(schema.mentions.userId, userId)];
  if (f.status === "unread") conds.push(isNull(schema.mentions.readAt));
  if (f.status === "read") conds.push(sql`${schema.mentions.readAt} is not null`);
  if (f.entityType) conds.push(eq(schema.mentions.entityType, f.entityType));
  const where = and(...conds);
  const [rows, [count], [unread]] = await Promise.all([
    ctx.tx.select({ m: schema.mentions, authorName: schema.users.name, authorEmail: schema.users.email }).from(schema.mentions).leftJoin(schema.users, eq(schema.users.id, schema.mentions.authorId)).where(where).orderBy(desc(schema.mentions.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.mentions).where(where),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.mentions).where(and(eq(schema.mentions.tenantId, ctx.tenantId), eq(schema.mentions.userId, userId), isNull(schema.mentions.readAt))),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize, unread: unread?.n ?? 0 };
}

export async function setMentionsRead(ctx: ServiceContext, userId: string, ids: string[] | "all", read: boolean): Promise<number> {
  const conds: SQL[] = [eq(schema.mentions.tenantId, ctx.tenantId), eq(schema.mentions.userId, userId)];
  if (ids !== "all") {
    if (!ids.length) return 0;
    conds.push(inArray(schema.mentions.id, ids));
  }
  const rows = await ctx.tx.update(schema.mentions).set({ readAt: read ? (ctx.now ?? new Date()) : null }).where(and(...conds)).returning({ id: schema.mentions.id });
  return rows.length;
}
