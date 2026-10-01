import { and, asc, eq, schema } from "@keel/db";
import type { TenantContext } from "./tenant";

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** Active members of the tenant, read through the tenant transaction (memberships are RLS-scoped). */
export async function tenantPeople(ctx: TenantContext): Promise<Person[]> {
  const rows = await ctx.run((tx) => tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true))).orderBy(asc(schema.users.name)));
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.email, email: r.email, role: r.role }));
}
