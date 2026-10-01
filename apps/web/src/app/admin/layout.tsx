import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@keel/config";
import { displayName, initials } from "@keel/core";
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
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b bg-sidebar text-sidebar-foreground lg:border-b-0 lg:border-r">
        <div className="flex flex-col lg:sticky lg:top-0 lg:h-screen">
        <div className="flex h-14 items-center gap-2.5 px-4 lg:border-b">
          <BrandMark />
          <span>
            <span className="block text-sm font-semibold leading-tight">{PRODUCT_NAME}</span>
            <span className="block text-[11px] leading-tight text-sidebar-muted">{t("console")}</span>
          </span>
          <div className="ml-auto lg:hidden">
            <UserMenu user={{ name: displayName(user), email: user.email, initials: initials(user), avatarUrl: avatarUrl(user) }} theme={user.theme} profileHref="/admin/profile" />
          </div>
        </div>
        <div className="lg:py-3">
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
