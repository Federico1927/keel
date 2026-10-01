import type { TenantContext } from "./tenant";

/** Audit identity for an action in a tenant: marks super-admin impersonation explicitly. */
export function auditActor(ctx: TenantContext): { actorUserId: string; actorType: "user" | "impersonation"; impersonatedBy: string | null } {
  return ctx.impersonation ? { actorUserId: ctx.user.id, actorType: "impersonation", impersonatedBy: ctx.impersonation.adminUserId } : { actorUserId: ctx.user.id, actorType: "user", impersonatedBy: null };
}
