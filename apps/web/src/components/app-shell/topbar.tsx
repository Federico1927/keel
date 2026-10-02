"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronsUpDown } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hullwise/ui";
import { LocaleSwitcher } from "@/components/locale-switcher";
import type { ThemePreference } from "@hullwise/ui/tokens";
import type { SidebarProps } from "./sidebar";
import { UserMenu, type MenuUser } from "./user-menu";
import { NotificationsBell, type BellItem } from "./notifications-bell";
import { SupportButton } from "./support-button";
import { CommandSearch } from "@/components/lists/command-search";

interface TopbarProps {
  sidebar: SidebarProps;
  user: MenuUser;
  theme: ThemePreference;
  role: string;
  memberships: { slug: string; name: string }[];
  isSuperAdmin: boolean;
  notifications: { unread: number; items: BellItem[]; locale: string };
  /** Present when the user may write to the platform owner. */
  support: { categories: string[] } | null;
}

export function Topbar({ sidebar, user, theme, role, memberships, isSuperAdmin, notifications, support }: TopbarProps) {
  const t = useTranslations();
  const router = useRouter();
  // compact below lg (#49, #72): workspace, search, bell and avatar; the language moves into the user menu, support into the bottom bar's "More"
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card px-3 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4 lg:static" style={{ height: "calc(3.5rem + env(safe-area-inset-top))" }}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="min-w-0 max-w-[12rem] gap-2 sm:max-w-[16rem]" data-testid="tenant-switcher">
            <span className="min-w-0 truncate">{sidebar.tenantName}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("shell.switch_tenant")}</DropdownMenuLabel>
          {memberships.map((m) => (
            <DropdownMenuItem key={m.slug} onSelect={() => router.push(`/t/${m.slug}`)}>
              {m.name}
            </DropdownMenuItem>
          ))}
          {isSuperAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/admin")}>{t("shell.admin_console")}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <CommandSearch slug={sidebar.tenantSlug} />
        {support && <span className="hidden lg:contents"><SupportButton slug={sidebar.tenantSlug} categories={support.categories} /></span>}
        <NotificationsBell slug={sidebar.tenantSlug} unread={notifications.unread} items={notifications.items} locale={notifications.locale} />
        <LocaleSwitcher className="hidden lg:block" />
        <UserMenu user={user} role={role} theme={theme} profileHref={`/t/${sidebar.tenantSlug}/profile`} languageHiddenFrom="lg" />
      </div>
    </header>
  );
}
