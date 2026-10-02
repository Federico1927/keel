"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronsUpDown, Menu } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@keel/ui";
import { LocaleSwitcher } from "@/components/locale-switcher";
import type { ThemePreference } from "@keel/ui/tokens";
import { SidebarNav, type SidebarProps } from "./sidebar";
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
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* At phone width (360–390px) the tenant name truncates and the language picker moves into the user menu. */}
      <header className="flex h-14 items-center gap-2 border-b bg-card px-4 sm:gap-3">
        <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" onClick={() => setOpen(true)} aria-label={t("shell.open_menu")}>
          <Menu />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="min-w-0 gap-2" data-testid="tenant-switcher">
              <span className="min-w-0 max-w-[12rem] truncate">{sidebar.tenantName}</span>
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
          {support && <SupportButton slug={sidebar.tenantSlug} categories={support.categories} />}
          <NotificationsBell slug={sidebar.tenantSlug} unread={notifications.unread} items={notifications.items} locale={notifications.locale} />
          <LocaleSwitcher className="hidden sm:block" />
          <UserMenu user={user} role={role} theme={theme} profileHref={`/t/${sidebar.tenantSlug}/profile`} languageHiddenFrom="sm" />
        </div>
      </header>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent side="right" className="w-72 max-w-[85vw] bg-sidebar p-0 text-sidebar-foreground [&>button]:text-sidebar-foreground">
          <DialogTitle className="sr-only">{t("shell.open_menu")}</DialogTitle>
          <SidebarNav {...sidebar} onNavigate={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
