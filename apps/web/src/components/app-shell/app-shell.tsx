import { PAGES, canViewPage, isPageEnabled } from "@keel/config";
import type { TenantContext } from "@/server/tenant";
import { getMemberships } from "@/server/session";
import { SidebarNav } from "./sidebar";
import { Topbar } from "./topbar";

export async function AppShell({ ctx, children }: { ctx: TenantContext; children: React.ReactNode }) {
  const memberships = await getMemberships(ctx.user.id);
  const allowedPages = PAGES.filter((p) => isPageEnabled(p, ctx.activeAddons) && canViewPage(ctx.role, p));
  const sidebar = { tenantSlug: ctx.tenant.slug, tenantName: ctx.tenant.name, allowedPages: [...allowedPages] };
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
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
