import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { adminDb, and, eq, schema, withTenant, type Transaction } from "@keel/db";
import { parseTenantSettings, type TenantSettings } from "@keel/core";
import { canDo, canViewPage, canWritePage, isPageEnabled, isTenantBlocked, type ActionKey, type PageKey, type TenantRole } from "@keel/config";
import { getCurrentUser, type CurrentUser } from "./session";

export interface TenantContext {
  user: CurrentUser;
  tenant: typeof schema.tenants.$inferSelect;
  settings: TenantSettings;
  role: TenantRole;
  activeAddons: string[];
  /** Set when a super-admin is impersonating the tenant (phase 10). */
  impersonation: { adminUserId: string } | null;
  locale: string;
  /** Runs a function inside the tenant transaction (RLS enforced). */
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * Resolves the tenant from the URL slug and checks membership. Platform tables are
 * read with the admin connection; everything after this point goes through `ctx.run`.
 */
export const getTenantContext = cache(async (slug: string): Promise<TenantContext> => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const db = adminDb();
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (!tenant) notFound();

  let role: TenantRole | null = null;
  let impersonation: TenantContext["impersonation"] = null;
  const [membership] = await db
    .select({ role: schema.tenantMemberships.role })
    .from(schema.tenantMemberships)
    .where(and(eq(schema.tenantMemberships.tenantId, tenant.id), eq(schema.tenantMemberships.userId, user.id), eq(schema.tenantMemberships.isActive, true)))
    .limit(1);
  if (membership) role = membership.role;
  else if (user.isSuperAdmin) {
    role = "owner";
    impersonation = { adminUserId: user.id };
  }
  if (!role) notFound();
  // suspended and churned tenants keep their users out (#48); the reason picks the message, never the note
  if (isTenantBlocked(tenant.status) && !user.isSuperAdmin) redirect(`/suspended?tenant=${tenant.slug}&reason=${blockedReason(tenant)}`);

  const addons = await db
    .select({ moduleKey: schema.tenantAddons.moduleKey })
    .from(schema.tenantAddons)
    .where(and(eq(schema.tenantAddons.tenantId, tenant.id), eq(schema.tenantAddons.isActive, true)));

  const ctx: TenantContext = {
    user,
    tenant,
    settings: parseTenantSettings(tenant.settings),
    role,
    activeAddons: addons.map((a) => a.moduleKey),
    impersonation,
    // the language the page is shown in (picker cookie, set from the profile at sign-in), so formats match the text
    locale: await getLocale(),
    run: (fn) => withTenant(tenant.id, fn),
  };
  return ctx;
});

/** What the blocked page tells the tenant's users: unpaid invoices, closed workspace or a platform decision. */
export function blockedReason(tenant: { status: string; statusReason: string | null }): "payment" | "churned" | "platform" {
  if (tenant.status === "churned") return "churned";
  return tenant.statusReason === "unpaid_invoice" || tenant.statusReason === "payment_overdue" ? "payment" : "platform";
}

/** Page guard: role permission and module flag. Unreachable pages are a 404, even by URL. */
export async function requirePage(slug: string, page: PageKey): Promise<TenantContext> {
  const ctx = await getTenantContext(slug);
  if (!isPageEnabled(page, ctx.activeAddons)) notFound();
  if (!canViewPage(ctx.role, page)) notFound();
  return ctx;
}

export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Action guard for server actions and route handlers. */
export async function requireAction(slug: string, action: ActionKey, page?: PageKey): Promise<TenantContext> {
  const ctx = await getTenantContext(slug);
  if (page && !isPageEnabled(page, ctx.activeAddons)) throw new ForbiddenError("module_disabled");
  if (!canDo(ctx.role, action)) throw new ForbiddenError(action);
  return ctx;
}

/** Write access to one page (the page's own level in the matrix, not the generic "edit" action). */
export async function requireWrite(slug: string, page: PageKey): Promise<TenantContext> {
  const ctx = await getTenantContext(slug);
  if (!isPageEnabled(page, ctx.activeAddons)) throw new ForbiddenError("module_disabled");
  if (!canWritePage(ctx.role, page)) throw new ForbiddenError(`write:${page}`);
  return ctx;
}
