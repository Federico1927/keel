"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SUPPORT_ATTACHMENT_MAX_BYTES } from "@keel/config";
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES, SupportError, adminReplyToTicket, adminSetTicketStatus, closeTicket, openSupportTicket, replyToTicket, type SupportAttachment } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { requireSuperAdmin } from "@/server/admin";
import { fail, ok, type ActionResult } from "@/server/action-result";

async function attachmentFrom(formData: FormData): Promise<SupportAttachment | null> {
  const f = formData.get("attachment");
  if (!f || typeof f === "string" || f.size === 0) return null;
  if (f.size > SUPPORT_ATTACHMENT_MAX_BYTES) throw new SupportError("attachment_too_large");
  return { name: f.name, type: f.type || "application/octet-stream", data: Buffer.from(await f.arrayBuffer()) };
}

function mapError(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof SupportError) return fail(e.code);
  throw e;
}

const openSchema = z.object({ subject: z.string().trim().min(1).max(160), category: z.enum(SUPPORT_CATEGORIES), body: z.string().trim().min(1).max(8000) });

/** Opened from the header by any member who can write to support; the attachment is stored with the message. */
export async function openTicketAction(slug: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireWrite(slug, "support");
    const parsed = openSchema.safeParse({ subject: formData.get("subject"), category: formData.get("category"), body: formData.get("body") });
    if (!parsed.success) return fail("invalid_input");
    const attachment = await attachmentFrom(formData);
    const r = await ctx.run((tx) => openSupportTicket({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { ...parsed.data, attachment }));
    revalidatePath(`/t/${slug}/support`);
    return ok({ id: r.id });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
  }
}

export async function replyTicketAction(slug: string, ticketId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "support");
    const body = z.string().trim().min(1).max(8000).safeParse(formData.get("body"));
    if (!body.success || !z.string().uuid().safeParse(ticketId).success) return fail("invalid_input");
    const attachment = await attachmentFrom(formData);
    await ctx.run((tx) => replyToTicket({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ticketId, { body: body.data, attachment }));
    revalidatePath(`/t/${slug}/support/${ticketId}`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function closeTicketAction(slug: string, ticketId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "support");
    if (!z.string().uuid().safeParse(ticketId).success) return fail("invalid_input");
    await ctx.run((tx) => closeTicket({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ticketId));
    revalidatePath(`/t/${slug}/support/${ticketId}`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

/* ---------- console ---------- */

export async function adminReplyAction(ticketId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  try {
    const body = z.string().trim().min(1).max(8000).safeParse(formData.get("body"));
    if (!body.success || !z.string().uuid().safeParse(ticketId).success) return fail("invalid_input");
    const attachment = await attachmentFrom(formData);
    await adminReplyToTicket(db, ticketId, user.id, { body: body.data, attachment, close: formData.get("close") === "on" });
    revalidatePath(`/admin/support/${ticketId}`);
    revalidatePath("/admin/support");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function adminSetTicketStatusAction(ticketId: string, status: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  const s = z.enum(SUPPORT_STATUSES).safeParse(status);
  if (!s.success || !z.string().uuid().safeParse(ticketId).success) return fail("invalid_input");
  try {
    await adminSetTicketStatus(db, ticketId, user.id, s.data);
  } catch (e) {
    return mapError(e);
  }
  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath("/admin/support");
  return ok();
}
