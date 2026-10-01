"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Building2, CreditCard, LayoutDashboard, LifeBuoy, Palette, ScrollText } from "lucide-react";
import { cn } from "@keel/ui";

export function AdminNav() {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  const items = [
    { href: "/admin", label: t("dashboard"), icon: LayoutDashboard, exact: true },
    { href: "/admin/tenants", label: t("tenants"), icon: Building2 },
    { href: "/admin/billing", label: t("billing"), icon: CreditCard },
    { href: "/admin/support", label: t("support"), icon: LifeBuoy },
    { href: "/admin/audit", label: t("audit"), icon: ScrollText },
    { href: "/admin/styleguide", label: t("styleguide"), icon: Palette },
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3">
      {items.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-sidebar-accent font-medium text-sidebar-foreground [&>svg]:text-primary" : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground")}>
            <i.icon className="h-4 w-4" /> {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
