"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@keel/ui";
import { PRODUCT_NAME } from "@keel/config";
import { BrandMark } from "@/components/brand-mark";
import { NAV_SECTIONS } from "./nav";

export interface SidebarProps {
  tenantSlug: string;
  tenantName: string;
  /** Pages the current user may open (role × module). */
  allowedPages: string[];
  /** Tenant logos from Settings → Branding; null shows the product mark and the tenant name. */
  logoLight?: string | null;
  logoDark?: string | null;
  /** Counts shown next to nav entries, by href (an add-on's queue). */
  badges?: Record<string, number>;
  onNavigate?: () => void;
}

export function SidebarNav({ tenantSlug, tenantName, allowedPages, logoLight, logoDark, badges, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const t = useTranslations();
  const base = `/t/${tenantSlug}`;
  const allowed = new Set(allowedPages);
  return (
    <nav className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <Link href={base} onClick={onNavigate} className="flex h-14 items-center gap-2.5 border-b px-4">
        {logoLight ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoLight} alt={tenantName} className="h-7 max-w-[10rem] object-contain dark:hidden" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoDark ?? logoLight} alt={tenantName} className="hidden h-7 max-w-[10rem] object-contain dark:block" />
          </>
        ) : (
          <>
            <BrandMark />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">{tenantName}</span>
              <span className="block text-[11px] leading-tight text-sidebar-muted">{PRODUCT_NAME}</span>
            </span>
          </>
        )}
      </Link>
      <div className="flex-1 space-y-4 overflow-y-auto px-2.5 py-4">
        {NAV_SECTIONS.map((section) => {
          const items = section.items.filter((i) => allowed.has(i.page));
          if (items.length === 0) return null;
          return (
            <div key={section.labelKey}>
              <p className="px-2 pb-1 text-[11px] font-medium text-sidebar-muted">{t(section.labelKey)}</p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const href = `${base}${item.href}`;
                  // longest matching entry wins, so /inventory/planning does not also light up /inventory
                  const matches = (h: string) => (h === "" ? pathname === base : pathname === `${base}${h}` || pathname.startsWith(`${base}${h}/`));
                  const active = matches(item.href) && !NAV_SECTIONS.some((sec) => sec.items.some((o) => allowed.has(o.page) && o.href.length > item.href.length && o.href.startsWith(item.href) && matches(o.href)));
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                          active && "bg-sidebar-accent font-medium text-sidebar-foreground",
                        )}
                      >
                        <Icon className={cn("h-4 w-4", active && "text-primary")} />
                        <span>{t(item.labelKey)}</span>
                        {badges?.[item.href] ? <span className="ml-auto rounded-full bg-primary/15 px-1.5 text-[11px] font-medium tabular text-primary" data-testid={`nav-badge-${item.page}`}>{badges[item.href]! > 99 ? "99+" : badges[item.href]}</span> : null}
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
