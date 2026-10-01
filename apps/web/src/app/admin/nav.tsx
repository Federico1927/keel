"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Building2, CreditCard, LayoutDashboard, ScrollText } from "lucide-react";
import { cn } from "@keel/ui";

export function AdminNav() {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  const items = [
    { href: "/admin", label: t("dashboard"), icon: LayoutDashboard, exact: true },
    { href: "/admin/tenants", label: t("tenants"), icon: Building2 },
    { href: "/admin/billing", label: t("billing"), icon: CreditCard },
    { href: "/admin/audit", label: t("audit"), icon: ScrollText },
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3">
      {items.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>
            <i.icon className="h-4 w-4" /> {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
