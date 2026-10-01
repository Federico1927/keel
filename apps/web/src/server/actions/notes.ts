"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { RECORD_NOTE_TYPES, addRecordNote, deleteRecordNote, type RecordNoteType } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { tenantPeople } from "@/server/people";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { displayName } from "@keel/core";

const PAGE: Record<RecordNoteType, "purchasing" | "returns"> = { purchase_order: "purchasing", return: "returns" };
const PATH: Record<RecordNoteType, string> = { purchase_order: "purchasing", return: "returns" };

/** Note with @mentions on a purchase order or a return: write access to that page is required. */
export async function addRecordNoteAction(slug: string, entityType: string, entityId: string, body: string): Promise<ActionResult<{ mentions: number }>> {
  try {
    if (!(RECORD_NOTE_TYPES as readonly string[]).includes(entityType) || !z.string().uuid().safeParse(entityId).success) return fail("invalid_input");
    const type = entityType as RecordNoteType;
    const ctx = await requireWrite(slug, PAGE[type]);
    const people = await tenantPeople(ctx);
    const r = await ctx.run((tx) => addRecordNote({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { entityType: type, entityId, body, allowedMentionIds: people.map((p) => p.id), authorName: displayName(ctx.user) }));
    revalidatePath(`/t/${slug}/${PATH[type]}/${entityId}`);
    return ok({ mentions: r.mentions.length });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof Error && (e.message === "invalid_note" || e.message === "not_found")) return fail(e.message === "not_found" ? "not_found" : "invalid_input");
    throw e;
  }
}

export async function removeRecordNoteAction(slug: string, entityType: string, entityId: string, noteId: string): Promise<ActionResult> {
  try {
    if (!(RECORD_NOTE_TYPES as readonly string[]).includes(entityType) || !z.string().uuid().safeParse(noteId).success) return fail("invalid_input");
    const type = entityType as RecordNoteType;
    const ctx = await requireWrite(slug, PAGE[type]);
    const done = await ctx.run((tx) => deleteRecordNote({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, noteId, ctx.role === "owner" || ctx.role === "admin"));
    revalidatePath(`/t/${slug}/${PATH[type]}/${entityId}`);
    return done ? ok() : fail("forbidden");
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
