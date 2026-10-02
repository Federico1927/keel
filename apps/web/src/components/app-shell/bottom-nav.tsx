"use client";
// i18n-client-namespaces: nav, mobile (labels come from nav.ts)
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Inbox, Menu } from "lucide-react";
import type { MobileNavKey } from "@hullwise/config";
import { Dialog, DialogContent, DialogTitle, cn } from "@hullwise/ui";
import { MOBILE_NAV_ITEMS } from "./nav";
import { SidebarNav, type SidebarProps } from "./sidebar";
import { SupportButton } from "./support-button";

/**
 * Phone and tablet navigation (#49, below `lg` where the sidebar is hidden): the user's four
 * destinations and "More", a bottom sheet with every page they can open, approvals and support (the
 * language is in the user menu).
 * Sits above the home bar; the page keeps room for it through `--bottom-nav-h`.
 */
export function BottomNav({ items, sidebar, support, approvals }: { items: MobileNavKey[]; sidebar: SidebarProps; support: { categories: string[] } | null; approvals: boolean }) {
  const t = useTranslations();
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  const base = `/t/${sidebar.tenantSlug}`;
  const matches = (h: string) => (h === "" ? pathname === base : pathname === `${base}${h}` || pathname.startsWith(`${base}${h}/`));
  // the longest matching destination is the active one (/inventory/stock-takes over /inventory)
  const active = items.filter((k) => matches(MOBILE_NAV_ITEMS[k].href)).sort((a, b) => MOBILE_NAV_ITEMS[b].href.length - MOBILE_NAV_ITEMS[a].href.length)[0];
  return (
    <>
      <nav aria-label={t("mobile.nav.label")} className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" data-testid="bottom-nav">
        <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
          {items.map((k) => {
            const item = MOBILE_NAV_ITEMS[k];
            const Icon = item.icon;
            const on = k === active;
            const badge = sidebar.badges?.[item.href];
            return (
              <li key={k} className="min-w-0">
                <Link href={`${base}${item.href}`} aria-current={on ? "page" : undefined} className={cn("relative flex h-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-muted-foreground", on && "text-primary")} data-testid={`bottom-nav-${k}`}>
                  <Icon className="h-5 w-5" aria-hidden />
                  <span className="max-w-full truncate">{t(item.labelKey)}</span>
                  {badge ? <span className="absolute right-[calc(50%-1.25rem)] top-1.5 rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground tabular">{badge > 99 ? "99+" : badge}</span> : null}
                </Link>
              </li>
            );
          })}
          <li className="min-w-0">
            <button type="button" onClick={() => setMore(true)} aria-expanded={more} className={cn("flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-muted-foreground", !active && pathname !== base && "text-primary")} data-testid="bottom-nav-more">
              <Menu className="h-5 w-5" aria-hidden />
              <span>{t("mobile.nav.more")}</span>
            </button>
          </li>
        </ul>
      </nav>
      <Dialog open={more} onOpenChange={setMore}>
        <DialogContent side="bottom" className="gap-0 bg-sidebar p-0 text-sidebar-foreground" closeLabel={t("mobile.close")}>
          <DialogTitle className="sr-only">{t("mobile.nav.more")}</DialogTitle>
          <div className="max-h-[70dvh] overflow-y-auto">
            <SidebarNav {...sidebar} onNavigate={() => setMore(false)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
            {approvals && (
              <Link href={`${base}/approvals`} onClick={() => setMore(false)} className="inline-flex h-11 items-center gap-2 rounded-md border px-3 text-sm" data-testid="more-approvals">
                <Inbox className="h-4 w-4" /> {t("mobile.nav.approvals")}
              </Link>
            )}
            {support && <SupportButton slug={sidebar.tenantSlug} categories={support.categories} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
