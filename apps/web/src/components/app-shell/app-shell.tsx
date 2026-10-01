import { PAGES, canViewPage, canWritePage, isPageEnabled } from "@keel/config";
import type { TenantContext } from "@/server/tenant";
import { getMemberships } from "@/server/session";
import { SidebarNav } from "./sidebar";
import { Topbar } from "./topbar";
import { SUPPORT_CATEGORIES, listNotifications, unreadCount } from "@keel/services";

export async function AppShell({ ctx, children }: { ctx: TenantContext; children: React.ReactNode }) {
  const memberships = await getMemberships(ctx.user.id);
  const allowedPages = PAGES.filter((p) => isPageEnabled(p, ctx.activeAddons) && canViewPage(ctx.role, p));
  const sidebar = { tenantSlug: ctx.tenant.slug, tenantName: ctx.tenant.name, allowedPages: [...allowedPages] };
  const { unread, items } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { unread: await unreadCount(s, ctx.user.id), items: await listNotifications(s, ctx.user.id, 15) };
  });
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarNav {...sidebar} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          sidebar={sidebar}
          userName={ctx.user.name ?? ctx.user.email}
          userEmail={ctx.user.email}
          role={ctx.role}
          memberships={memberships.map((m) => ({ slug: m.slug, name: m.name }))}
          isSuperAdmin={ctx.user.isSuperAdmin}
          impersonating={ctx.impersonation !== null}
          support={canWritePage(ctx.role, "support") ? { categories: [...SUPPORT_CATEGORIES] } : null}
          notifications={{ unread, items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, severity: n.severity, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })), locale: ctx.locale }}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
