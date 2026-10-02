"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { BellRing, Bot, Building2, ChartLine, CreditCard, LayoutDashboard, LifeBuoy, ListChecks, Mail, Package, Palette, Plug, Repeat, ScrollText, Users } from "lucide-react";
import { cn } from "@keel/ui";
import { ADMIN_NAV, type AdminNavKey } from "./nav-items";

const ICONS: Record<AdminNavKey, typeof LayoutDashboard> = { dashboard: LayoutDashboard, metrics: ChartLine, tenants: Building2, plans: Package, users: Users, billing: CreditCard, subscriptions: Repeat, integrations: Plug, mcp: Bot, email: Mail, jobs: ListChecks, alerts: BellRing, support: LifeBuoy, audit: ScrollText, styleguide: Palette };

export function AdminNav() {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:gap-3 lg:px-3" aria-label={t("label")}>
      {ADMIN_NAV.map((g) => (
        <div key={g.group} className="flex gap-1 lg:flex-col" data-testid={`admin-nav-${g.group}`}>
          <p className="hidden px-3 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted lg:block">{t(`groups.${g.group}`)}</p>
          {g.items.map((i) => {
            const Icon = ICONS[i.key];
            const active = "exact" in i && i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
            return (
              <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={cn("flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm", active ? "bg-platform/10 font-medium text-platform" : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground")}>
                <Icon className="h-4 w-4" /> {t(i.key)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
