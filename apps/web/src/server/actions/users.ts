"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@hullwise/db";
import { TENANT_ROLES, canManageRole, isTenantRole } from "@hullwise/config";
import { AccountError, createInvitation, resendInvitation, revokeInvitation, sendAccessDisabledNotice } from "@hullwise/services";
import { requireAction, ForbiddenError } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { displayName } from "@hullwise/core";
import "@/server/email";

const inviteSchema = z.object({ email: z.string().trim().email().max(254), name: z.string().trim().max(120).optional(), role: z.enum(TENANT_ROLES) });

function failFrom(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof AccountError) return fail(e.code);
  throw e;
}

/**
 * Invites a person (#52): an `invitations` row and the invitation email with the accept link.
 * No account or membership exists until the person accepts.
 */
export async function inviteMember(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    await ctx.run((tx) => createInvitation({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { email: parsed.data.email, role: parsed.data.role, name: parsed.data.name ?? null, inviterName: displayName(ctx.user), tenantName: ctx.tenant.name, tenantLocale: ctx.tenant.defaultLocale }, { auditAs: auditActor(ctx), actorRole: ctx.role }));
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function resendInvitationAction(slug: string, invitationId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    if (!z.string().uuid().safeParse(invitationId).success) return fail("invalid_input");
    await ctx.run((tx) => resendInvitation({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, invitationId, { inviterName: displayName(ctx.user), tenantName: ctx.tenant.name, tenantLocale: ctx.tenant.defaultLocale }, { auditAs: auditActor(ctx), actorRole: ctx.role }));
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function revokeInvitationAction(slug: string, invitationId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    if (!z.string().uuid().safeParse(invitationId).success) return fail("invalid_input");
    await ctx.run((tx) => revokeInvitation({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, invitationId, { auditAs: auditActor(ctx), actorRole: ctx.role }));
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function changeMemberRole(slug: string, userId: string, role: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    if (!isTenantRole(role)) return fail("invalid_input");
    if (userId === ctx.user.id) return fail("cannot_change_self");
    const db = adminDb();
    const [m] = await db.select().from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.userId, userId))).limit(1);
    if (!m) return fail("not_found");
    if (!canManageRole(ctx.role, m.role) || !canManageRole(ctx.role, role)) return fail("forbidden");
    await db.update(schema.tenantMemberships).set({ role }).where(eq(schema.tenantMemberships.id, m.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "membership.role_changed", entityType: "user", entityId: userId, diff: { role: { from: m.role, to: role } } }));
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function setMemberActive(slug: string, userId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    if (userId === ctx.user.id) return fail("cannot_change_self");
    const db = adminDb();
    const [m] = await db.select().from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.userId, userId))).limit(1);
    if (!m) return fail("not_found");
    if (!canManageRole(ctx.role, m.role)) return fail("forbidden");
    await db.update(schema.tenantMemberships).set({ isActive }).where(eq(schema.tenantMemberships.id, m.id));
    await ctx.run(async (tx) => {
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: isActive ? "membership.reactivated" : "membership.deactivated", entityType: "user", entityId: userId, diff: { isActive: { from: m.isActive, to: isActive } } });
      // the person learns their access ended (security notice, #52)
      if (!isActive && m.isActive) await sendAccessDisabledNotice({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { userId, tenantName: ctx.tenant.name, membershipId: m.id });
    });
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
