import { PAGES, canViewPage, canWritePage, isPageEnabled } from "@keel/config";
import type { TenantContext } from "@/server/tenant";
import { getMemberships } from "@/server/session";
import { SidebarNav } from "./sidebar";
import { Topbar } from "./topbar";
import { ImpersonationBanner } from "./impersonation-banner";
import { SUPPORT_CATEGORIES, listNotifications, tenantBillingBanner, unreadCount } from "@keel/services";
import { BillingBanner } from "./billing-banner";
import { displayName, initials } from "@keel/core";
import { brandCss, loadBrand } from "@/server/branding";
import { avatarUrl } from "@/server/avatar";

export async function AppShell({ ctx, children }: { ctx: TenantContext; children: React.ReactNode }) {
  const memberships = await getMemberships(ctx.user.id);
  const allowedPages = PAGES.filter((p) => isPageEnabled(p, ctx.activeAddons) && canViewPage(ctx.role, p));
  const brand = await loadBrand(ctx.tenant.id, ctx.tenant.slug);
  const css = brandCss(brand);
  const sidebar = { tenantSlug: ctx.tenant.slug, tenantName: ctx.tenant.name, allowedPages: [...allowedPages], logoLight: brand.logoLight, logoDark: brand.logoDark };
  const { unread, items, banner } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    // owners see what they owe (#53): past due, or a payment the bank wants confirmed
    return { unread: await unreadCount(s, ctx.user.id), items: await listNotifications(s, ctx.user.id, 15), banner: ctx.role === "owner" ? await tenantBillingBanner(s, ctx.tenant) : null };
  });
  return (
    <>
    {ctx.impersonation && <ImpersonationBanner tenantName={ctx.tenant.name} slug={ctx.tenant.slug} />}
    {banner && <BillingBanner banner={banner} slug={ctx.tenant.slug} />}
    <div className="flex min-h-screen">
      {css && <style data-tenant-brand dangerouslySetInnerHTML={{ __html: css }} />}
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarNav {...sidebar} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          sidebar={sidebar}
          user={{ name: displayName(ctx.user), email: ctx.user.email, initials: initials(ctx.user), avatarUrl: avatarUrl(ctx.user) }}
          theme={ctx.user.theme}
          role={ctx.role}
          memberships={memberships.map((m) => ({ slug: m.slug, name: m.name }))}
          isSuperAdmin={ctx.user.isSuperAdmin}
          support={canWritePage(ctx.role, "support") ? { categories: [...SUPPORT_CATEGORIES] } : null}
          notifications={{ unread, items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, severity: n.severity, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })), locale: ctx.locale }}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
    </>
  );
}
