"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronsUpDown, LogOut, Menu, ShieldAlert } from "lucide-react";
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
import { signOutAction } from "@/server/actions/auth";
import { SidebarNav, type SidebarProps } from "./sidebar";

interface TopbarProps {
  sidebar: SidebarProps;
  userName: string;
  userEmail: string;
  role: string;
  memberships: { slug: string; name: string }[];
  isSuperAdmin: boolean;
  impersonating: boolean;
}

export function Topbar({ sidebar, userName, userEmail, role, memberships, isSuperAdmin, impersonating }: TopbarProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      {impersonating && (
        <div className="flex items-center gap-2 bg-warning px-4 py-1.5 text-xs font-medium text-warning-foreground">
          <ShieldAlert className="h-4 w-4" />
          {t("shell.impersonating", { tenant: sidebar.tenantName })}
          <a href="/admin" className="ml-auto underline">
            {t("shell.back_to_admin")}
          </a>
        </div>
      )}
      <header className="flex h-14 items-center gap-3 border-b bg-card px-4">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label={t("shell.open_menu")}>
          <Menu />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <span className="max-w-[12rem] truncate">{sidebar.tenantName}</span>
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
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <span className="hidden sm:inline">{userName}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(`roles.${role}`)}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="font-normal">
                <p className="text-sm text-foreground">{userName}</p>
                <p className="text-xs">{userEmail}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => signOutAction()}>
                <LogOut /> {t("common.sign_out")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
