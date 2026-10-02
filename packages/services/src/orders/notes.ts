import { and, eq, schema } from "@keel/db";
import { extractMentions } from "@keel/core";
import type { ServiceContext } from "../context";
import { notifyUsers, recordMentions } from "../notifications";

/** Adds an internal note; mentions are validated against the allowed member ids and notified. */
export async function addOrderNote(ctx: ServiceContext, input: { orderId: string; body: string; allowedMentionIds: string[]; link: string; orderName: string; authorName: string; eventMetadata?: Record<string, unknown> }): Promise<{ noteId: string; mentions: string[] }> {
  const body = input.body.trim();
  if (!body || body.length > 4000) throw new Error("invalid_note");
  const allowed = new Set(input.allowedMentionIds);
  const mentions = extractMentions(body).map((m) => m.userId).filter((id) => allowed.has(id) && id !== ctx.actor.userId);
  const [note] = await ctx.tx.insert(schema.orderNotes).values({ tenantId: ctx.tenantId, orderId: input.orderId, authorId: ctx.actor.userId, body, mentions, createdAt: ctx.now ?? new Date() }).returning({ id: schema.orderNotes.id });
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "note_added", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { noteId: note!.id, mentions: mentions.length, ...(input.eventMetadata ?? {}) }, createdAt: ctx.now ?? new Date() });
  if (mentions.length) {
    await notifyUsers(ctx, { userIds: mentions, type: "mention", title: `${input.authorName} · ${input.orderName}`, body: body.length > 140 ? body.slice(0, 137) + "…" : body, link: input.link, metadata: { orderId: input.orderId, noteId: note!.id }, email: { template: "mention", data: { authorName: input.authorName, recordLabel: input.orderName, excerpt: body } } });
    await recordMentions(ctx, { userIds: mentions, entityType: "order", entityId: input.orderId, entityLabel: input.orderName, noteId: note!.id, body, link: input.link });
  }
  return { noteId: note!.id, mentions };
}

export async function deleteOrderNote(ctx: ServiceContext, noteId: string, isAdmin: boolean): Promise<boolean> {
  const [note] = await ctx.tx.select().from(schema.orderNotes).where(and(eq(schema.orderNotes.tenantId, ctx.tenantId), eq(schema.orderNotes.id, noteId))).limit(1);
  if (!note) return false;
  if (!isAdmin && note.authorId !== ctx.actor.userId) return false;
  await ctx.tx.delete(schema.orderNotes).where(eq(schema.orderNotes.id, noteId));
  return true;
}
