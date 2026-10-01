"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { TENANT_ROLES, canManageRole, isTenantRole } from "@keel/config";
import { TRANSACTIONAL_EMAIL, appBaseUrl, sendTenantEmail } from "@keel/services";
import { requireAction, ForbiddenError } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const inviteSchema = z.object({ email: z.string().email().toLowerCase(), name: z.string().trim().min(1).max(80), role: z.enum(TENANT_ROLES) });

/**
 * Invites a user: creates the platform user if needed (random password, the person
 * signs in through the magic link) and the membership. Platform tables → admin connection.
 */
export async function inviteMember(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_users", "users");
    const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    if (!canManageRole(ctx.role, parsed.data.role)) return fail("forbidden");
    const db = adminDb();
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, parsed.data.email)).limit(1);
    let userId = existing?.id;
    if (!userId) {
      const [created] = await db
        .insert(schema.users)
        .values({ email: parsed.data.email, name: parsed.data.name, passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 10) })
        .returning({ id: schema.users.id });
      userId = created!.id;
    }
    await db
      .insert(schema.tenantMemberships)
      .values({ tenantId: ctx.tenant.id, userId, role: parsed.data.role })
      .onConflictDoUpdate({ target: [schema.tenantMemberships.tenantId, schema.tenantMemberships.userId], set: { role: parsed.data.role, isActive: true } });
    const [invitee] = await db.select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const delivery = await ctx.run(async (tx) => {
      const sent = await sendTenantEmail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { to: parsed.data.email, template: "invite", data: { tenantName: ctx.tenant.name, inviterName: ctx.user.name ?? ctx.user.email, role: parsed.data.role, url: `${appBaseUrl()}/login` }, locale: invitee?.locale ?? ctx.tenant.defaultLocale, category: TRANSACTIONAL_EMAIL });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "membership.invited", entityType: "user", entityId: userId, metadata: { email: parsed.data.email, role: parsed.data.role, email_delivery: sent.outcome } });
      return sent;
    });
    console.info(`[users] invited ${parsed.data.email} to ${slug} as ${parsed.data.role} (invite email: ${delivery.outcome}); sign-in via magic link at /login`);
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
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
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: isActive ? "membership.reactivated" : "membership.deactivated", entityType: "user", entityId: userId }));
    revalidatePath(`/t/${slug}/users`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
