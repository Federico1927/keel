import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { decode } from "next-auth/jwt";
import { adminDb, and, eq, schema } from "@hullwise/db";
import { getAccountProfile } from "@hullwise/services";
import { auth } from "@/auth";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  preferredName: string | null;
  jobTitle: string | null;
  isSuperAdmin: boolean;
  locale: string | null;
  /** The user's own time zone; null → the tenant's. */
  timeZone: string | null;
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  /** Cache-busting version of the profile photo; null when there is none. */
  avatarVersion: number | null;
  sessionVersion: number;
}

/**
 * The signed-in user, read from the database on every request (once, cached): profile edits
 * show at once, and a session whose version is older than the user's (password changed, "sign
 * out of other sessions") counts as signed out.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  const p = await getAccountProfile(adminDb(), session.user.id);
  if (!p || p.disabled) return null;
  if (p.sessionVersion !== (session.user.sessionVersion ?? 0) && (await rewrittenTokenVersion(p.id)) !== p.sessionVersion) return null;
  return {
    id: p.id,
    email: p.email,
    name: p.name,
    preferredName: p.preferredName,
    jobTitle: p.jobTitle,
    isSuperAdmin: p.isSuperAdmin,
    locale: p.locale,
    timeZone: p.timeZone,
    theme: p.theme,
    density: p.density,
    avatarVersion: p.avatarVersion,
    sessionVersion: p.sessionVersion,
  };
});

/**
 * Session version of a token rewritten earlier in this same request (a server action that just
 * moved the version re-renders the page with the request's old cookie header; `cookies()` already
 * holds the new token). Null when there is none or it belongs to someone else.
 */
async function rewrittenTokenVersion(userId: string): Promise<number | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const jar = await cookies();
  for (const name of ["__Secure-authjs.session-token", "authjs.session-token"]) {
    const raw = jar.get(name)?.value;
    if (!raw) continue;
    try {
      const token = await decode({ token: raw, secret, salt: name });
      return token?.uid === userId && typeof token.sv === "number" ? token.sv : null;
    } catch {
      return null;
    }
  }
  return null;
}

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
