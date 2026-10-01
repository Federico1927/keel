"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@keel/ui";
import { PRODUCT_NAME } from "@keel/config";
import { NAV_SECTIONS } from "./nav";

export interface SidebarProps {
  tenantSlug: string;
  tenantName: string;
  /** Pages the current user may open (role × module). */
  allowedPages: string[];
  onNavigate?: () => void;
}

export function SidebarNav({ tenantSlug, tenantName, allowedPages, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const t = useTranslations();
  const base = `/t/${tenantSlug}`;
  const allowed = new Set(allowedPages);
  return (
    <nav className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-5 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-sidebar-muted">{PRODUCT_NAME}</p>
        <p className="mt-1 truncate font-serif text-lg">{tenantName}</p>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {NAV_SECTIONS.map((section) => {
          const items = section.items.filter((i) => allowed.has(i.page));
          if (items.length === 0) return null;
          return (
            <div key={section.labelKey}>
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">{t(section.labelKey)}</p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const href = `${base}${item.href}`;
                  const active = item.href === "" ? pathname === base : pathname.startsWith(href);
                  const Icon = item.icon;
                  return (
                    <li key={item.page}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                          active && "bg-sidebar-accent font-medium text-white",
                        )}
                      >
                        <Icon className="h-4 w-4 opacity-80" />
                        <span>{t(item.labelKey)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
