import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@hullwise/config";
import { displayName, initials } from "@hullwise/core";
import { Badge } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { avatarUrl } from "@/server/avatar";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { UserMenu } from "@/components/app-shell/user-menu";
import { AdminNav } from "./nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSuperAdmin();
  if (!user.name?.trim()) redirect("/welcome?next=/admin");
  const t = await getTranslations("admin");
  return (
    // platform mode (#48): a violet stripe, accent and "Platform" label that never appear inside a tenant
    <div className="min-h-screen border-t-4 border-t-platform bg-background lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]" data-testid="platform-mode">
      <aside className="border-b bg-sidebar text-sidebar-foreground lg:border-b-0 lg:border-r">
        <div className="flex flex-col lg:sticky lg:top-0 lg:h-[calc(100vh-4px)]">
        <div className="flex h-14 items-center gap-2.5 px-4 lg:border-b">
          <BrandMark />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-semibold leading-tight">{PRODUCT_NAME} <Badge variant="platform" className="px-1.5 py-0 text-[10px] uppercase tracking-wide" data-testid="platform-label">{t("platform_label")}</Badge></span>
            <span className="block text-[11px] leading-tight text-sidebar-muted">{t("console")}</span>
          </span>
          <div className="ml-auto lg:hidden">
            <UserMenu user={{ name: displayName(user), email: user.email, initials: initials(user), avatarUrl: avatarUrl(user) }} theme={user.theme} profileHref="/admin/profile" />
          </div>
        </div>
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:py-3">
          <AdminNav />
        </div>
        <div className="mt-auto hidden items-center gap-2 border-t px-3 py-3 lg:flex">
          <UserMenu user={{ name: displayName(user), email: user.email, initials: initials(user), avatarUrl: avatarUrl(user) }} theme={user.theme} profileHref="/admin/profile" />
          <LocaleSwitcher className="ml-auto block w-28 shrink-0" />
        </div>
        </div>
      </aside>
      <main className="px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
