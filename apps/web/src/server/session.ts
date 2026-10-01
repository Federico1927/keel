import { cache } from "react";
import { redirect } from "next/navigation";
import { adminDb, and, eq, schema } from "@keel/db";
import { auth } from "@/auth";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
  locale: string | null;
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? null,
    isSuperAdmin: session.user.isSuperAdmin,
    locale: session.user.locale,
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export interface MembershipSummary {
  tenantId: string;
  slug: string;
  name: string;
  role: (typeof schema.tenantMemberships.$inferSelect)["role"];
  status: (typeof schema.tenants.$inferSelect)["status"];
  defaultLocale: string;
}

/** Platform-level lookup (admin connection): which tenants can this user open? */
export const getMemberships = cache(async (userId: string): Promise<MembershipSummary[]> => {
  const rows = await adminDb()
    .select({
      tenantId: schema.tenants.id,
      slug: schema.tenants.slug,
      name: schema.tenants.name,
      role: schema.tenantMemberships.role,
      status: schema.tenants.status,
      defaultLocale: schema.tenants.defaultLocale,
    })
    .from(schema.tenantMemberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId))
    .where(and(eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true)))
    .orderBy(schema.tenants.name);
  return rows;
});
