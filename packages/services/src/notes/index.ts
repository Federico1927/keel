import { and, asc, eq, recordAudit, schema } from "@hullwise/db";
import { extractMentions } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { notifyUsers, recordMentions } from "../notifications";
import { recordRef } from "../tasks";

/** Records that take internal notes through `record_notes` (orders keep their own `order_notes`). */
export const RECORD_NOTE_TYPES = ["purchase_order", "return"] as const;
export type RecordNoteType = (typeof RECORD_NOTE_TYPES)[number];

export async function listRecordNotes(ctx: ServiceContext, entityType: RecordNoteType, entityId: string) {
  return ctx.tx.select({ n: schema.recordNotes, authorName: schema.users.name, authorEmail: schema.users.email }).from(schema.recordNotes).leftJoin(schema.users, eq(schema.users.id, schema.recordNotes.authorId)).where(and(eq(schema.recordNotes.tenantId, ctx.tenantId), eq(schema.recordNotes.entityType, entityType), eq(schema.recordNotes.entityId, entityId))).orderBy(asc(schema.recordNotes.createdAt));
}

/** Adds a note to a purchase order or return; mentions of active members are notified (preferences apply) and land in their inbox. */
export async function addRecordNote(ctx: ServiceContext, input: { entityType: RecordNoteType; entityId: string; body: string; allowedMentionIds: string[]; authorName: string }): Promise<{ noteId: string; mentions: string[] }> {
  const body = input.body.trim();
  if (!body || body.length > 4000) throw new Error("invalid_note");
  const ref = await recordRef(ctx, input.entityType, input.entityId);
  if (!ref) throw new Error("not_found");
  const allowed = new Set(input.allowedMentionIds);
  const mentions = extractMentions(body).map((m) => m.userId).filter((id) => allowed.has(id) && id !== ctx.actor.userId);
  const now = ctx.now ?? new Date();
  const [note] = await ctx.tx.insert(schema.recordNotes).values({ tenantId: ctx.tenantId, entityType: input.entityType, entityId: input.entityId, authorId: ctx.actor.userId, body, mentions, createdAt: now }).returning({ id: schema.recordNotes.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "note.added", entityType: input.entityType, entityId: input.entityId, diff: { notes: { from: null, to: note!.id } }, metadata: { mentions: mentions.length } });
  if (mentions.length) {
    await notifyUsers(ctx, { userIds: mentions, type: "mention", title: `${input.authorName} · ${ref.label}`, body: body.length > 140 ? body.slice(0, 137) + "…" : body, link: ref.link, metadata: { entityType: input.entityType, entityId: input.entityId, noteId: note!.id }, email: { template: "mention", data: { authorName: input.authorName, recordLabel: ref.label, excerpt: body } } });
    await recordMentions(ctx, { userIds: mentions, entityType: input.entityType, entityId: input.entityId, entityLabel: ref.label, noteId: note!.id, body, link: ref.link });
  }
  return { noteId: note!.id, mentions };
}

export async function deleteRecordNote(ctx: ServiceContext, noteId: string, isAdmin: boolean): Promise<boolean> {
  const [note] = await ctx.tx.select().from(schema.recordNotes).where(and(eq(schema.recordNotes.tenantId, ctx.tenantId), eq(schema.recordNotes.id, noteId))).limit(1);
  if (!note || (!isAdmin && note.authorId !== ctx.actor.userId)) return false;
  await ctx.tx.delete(schema.recordNotes).where(eq(schema.recordNotes.id, noteId));
  await ctx.tx.delete(schema.mentions).where(and(eq(schema.mentions.tenantId, ctx.tenantId), eq(schema.mentions.noteId, noteId)));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "note.deleted", entityType: note.entityType, entityId: note.entityId, diff: { notes: { from: noteId, to: null } } });
  return true;
}
