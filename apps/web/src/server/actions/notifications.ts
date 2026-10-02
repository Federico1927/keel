"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NOTIFICATION_CHANNELS, isNotificationType } from "@keel/config";
import { normalizePhone } from "@keel/core";
import { addEmailSuppression, addPhoneSuppression, markAllRead, removeEmailSuppression, resetNotificationPreferences, setMentionsRead, setNotificationPreference, setNotificationsRead, type ServiceContext } from "@keel/services";
import type { Transaction } from "@keel/db";
import { ForbiddenError, getTenantContext, requireAction, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: Transaction): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const ids = z.array(z.string().uuid()).max(200);

export async function markNotificationsRead(slug: string): Promise<void> {
  const ctx = await getTenantContext(slug);
  await ctx.run((tx) => markAllRead(svc(ctx, tx), ctx.user.id));
  revalidatePath(`/t/${slug}`, "layout");
}

/** Read/unread on some of the user's own notifications (others' ids are ignored by the service). */
export async function setNotificationsReadAction(slug: string, notificationIds: string[], read: boolean): Promise<ActionResult> {
  const ctx = await requirePage(slug, "notifications");
  const parsed = ids.safeParse(notificationIds);
  if (!parsed.success) return fail("invalid_input");
  await ctx.run((tx) => setNotificationsRead(svc(ctx, tx), ctx.user.id, parsed.data, read));
  revalidatePath(`/t/${slug}`, "layout");
  return ok();
}

export async function setMentionsReadAction(slug: string, mentionIds: string[] | "all", read: boolean): Promise<ActionResult> {
  const ctx = await requirePage(slug, "notifications");
  if (mentionIds !== "all" && !ids.safeParse(mentionIds).success) return fail("invalid_input");
  await ctx.run((tx) => setMentionsRead(svc(ctx, tx), ctx.user.id, mentionIds, read));
  revalidatePath(`/t/${slug}/notifications/mentions`);
  return ok();
}

/** One preference cell of the current user; `null` restores the default. */
export async function setPreferenceAction(slug: string, type: string, channel: string, enabled: boolean | null): Promise<ActionResult> {
  const ctx = await requirePage(slug, "notifications");
  if (!isNotificationType(type) || !(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) return fail("invalid_input");
  try {
    await ctx.run((tx) => setNotificationPreference(svc(ctx, tx), ctx.user.id, type, channel as (typeof NOTIFICATION_CHANNELS)[number], enabled));
  } catch {
    return fail("invalid_input");
  }
  revalidatePath(`/t/${slug}/notifications/preferences`);
  return ok();
}

export async function resetPreferencesAction(slug: string): Promise<ActionResult> {
  const ctx = await requirePage(slug, "notifications");
  await ctx.run((tx) => resetNotificationPreferences(svc(ctx, tx), ctx.user.id));
  revalidatePath(`/t/${slug}/notifications/preferences`);
  return ok();
}

/** An email address, or a phone number (SMS and WhatsApp campaigns share the list, #34). */
const suppressionSchema = z.object({ email: z.string().trim().min(3).max(254), category: z.string().trim().min(1).max(40).default("all"), note: z.string().trim().max(200).optional() });

export async function addSuppressionAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "notifications");
    const parsed = suppressionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    const identity = parsed.data.email;
    if (identity.includes("@")) {
      if (!z.string().email().safeParse(identity).success) return fail("invalid_input");
      await ctx.run((tx) => addEmailSuppression(svc(ctx, tx), { email: identity.toLowerCase(), reason: "manual", category: parsed.data.category, source: "app", note: parsed.data.note ?? null }));
    } else {
      const phone = normalizePhone(identity, ctx.tenant.country);
      if (!phone) return fail("invalid_input");
      await ctx.run((tx) => addPhoneSuppression(svc(ctx, tx), { phone, reason: "manual", category: parsed.data.category, source: "app", note: parsed.data.note ?? null }));
    }
    revalidatePath(`/t/${slug}/notifications/suppressions`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function removeSuppressionAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "notifications");
    if (!z.string().uuid().safeParse(id).success) return fail("invalid_input");
    const done = await ctx.run((tx) => removeEmailSuppression(svc(ctx, tx), id));
    revalidatePath(`/t/${slug}/notifications/suppressions`);
    return done ? ok() : fail("not_found");
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
