import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@keel/config";
import { requireSuperAdmin } from "@/server/admin";
import { AdminNav } from "./nav";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { signOutAction } from "@/server/actions/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b bg-card lg:border-b-0 lg:border-r">
        <div className="px-4 py-4">
          <p className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</p>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("console")}</p>
        </div>
        <AdminNav />
        <div className="mt-auto px-4 py-4 text-xs text-muted-foreground">
          <p className="truncate">{user.email}</p>
          <div className="mt-2 flex items-center gap-2">
            <LocaleSwitcher />
            <form action={signOutAction}><button type="submit" className="underline">{t("sign_out")}</button></form>
          </div>
        </div>
      </aside>
      <main className="px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
