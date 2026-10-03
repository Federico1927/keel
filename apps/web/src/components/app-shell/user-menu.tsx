"use client";
import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Check, Languages, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { SUPPORTED_LOCALES } from "@hullwise/config";
import { Avatar, Button, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@hullwise/ui";
import type { ThemePreference } from "@hullwise/ui/tokens";
import { signOutAction } from "@/server/actions/auth";
import { setThemeAction } from "@/server/actions/profile";
import { setLocaleAction } from "@/i18n/locale-actions";

export interface MenuUser {
  /** displayName(): preferred name → full name → email local part. */
  name: string;
  email: string;
  initials: string;
  avatarUrl: string | null;
}

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Breakpoint from which the page shows its own language picker, so the menu stops repeating it. */
const LANGUAGE_HIDDEN_FROM = { sm: "sm:hidden", lg: "lg:hidden" } as const;

/**
 * Avatar menu: profile, theme (saved on the profile, applied by the server on the next render), sign out.
 * With `languageHiddenFrom` it also carries the language choice on narrow screens, where the header
 * has no room for the picker.
 */
export function UserMenu({ user, role, theme, profileHref, languageHiddenFrom }: { user: MenuUser; role?: string; theme: ThemePreference; profileHref: string; languageHiddenFrom?: keyof typeof LANGUAGE_HIDDEN_FROM }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-1.5 sm:px-2" aria-label={t("profile.menu_label", { name: user.name })} data-testid="user-menu">
          <Avatar src={user.avatarUrl} initials={user.initials} />
          <span className="hidden max-w-[10rem] truncate sm:inline" data-testid="user-menu-name">{user.name}</span>
          {role && <span className="hidden rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground md:inline">{t(`roles.${role}`)}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={profileHref}>
            <UserRound /> {t("profile.menu")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("theme.label")}</DropdownMenuLabel>
        {(["light", "dark", "system"] as const).map((v) => {
          const Icon = THEME_ICONS[v];
          return (
            <DropdownMenuItem
              key={v}
              disabled={pending}
              data-testid={`theme-${v}`}
              onSelect={(e) => {
                e.preventDefault();
                start(async () => {
                  await setThemeAction(v);
                  router.refresh();
                });
              }}
            >
              <Icon /> <span className="flex-1">{t(`theme.${v}`)}</span>
              {theme === v && <Check className="text-primary" />}
            </DropdownMenuItem>
          );
        })}
        {languageHiddenFrom && (
          <DropdownMenuGroup className={LANGUAGE_HIDDEN_FROM[languageHiddenFrom]} data-testid="user-menu-language">
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("common.language")}</DropdownMenuLabel>
            {SUPPORTED_LOCALES.map((l) => (
              <DropdownMenuItem
                key={l}
                disabled={pending}
                data-testid={`locale-${l}`}
                onSelect={(e) => {
                  e.preventDefault();
                  start(async () => {
                    await setLocaleAction(l);
                    router.refresh();
                  });
                }}
              >
                <Languages /> <span className="flex-1">{t(`common.locales.${l}`)}</span>
                {locale === l && <Check className="text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOutAction()}>
          <LogOut /> {t("common.sign_out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
