"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Menu, X } from "lucide-react";
import {
  APP_URL,
  LANDING_LOCALES,
  PRODUCT_NAME,
  demoHref,
  localePath,
  type LandingLocale,
} from "@/config/site";
import { buttonClass } from "@/components/ui";
import { Logo } from "@/components/logo";
import { cx } from "@/lib/cx";

const LOCALE_NAMES: Record<LandingLocale, string> = { en: "English", it: "Italiano" };

export function Header({ locale }: { locale: LandingLocale }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const base = localePath(locale);
  const links = [
    { href: `${base}#modules`, label: t("nav.modules") },
    { href: `${base}#how`, label: t("nav.how") },
    { href: `${base}#pricing`, label: t("nav.pricing") },
    { href: `${base}#faq`, label: t("nav.faq") },
  ];
  const demo = demoHref(`${PRODUCT_NAME} demo`);
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t("nav.skip")}
      </a>
      <div className="container-x flex h-16 items-center justify-between gap-6">
        <Link
          href={base}
          className="flex items-center gap-2 font-serif text-xl tracking-tight"
          aria-label={PRODUCT_NAME}
        >
          <Logo className="size-7" />
          {PRODUCT_NAME}
        </Link>
        <nav className="hidden items-center gap-7 text-sm md:flex" aria-label="Main">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          <LocaleSwitch current={locale} label={t("nav.language")} />
          <a
            href={`${APP_URL}/login`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("nav.sign_in")}
          </a>
          <a href={demo} className={buttonClass("primary", "md")} {...external(demo)}>
            {t("nav.cta")}
          </a>
        </div>
        <button
          type="button"
          className="inline-flex size-10 items-center justify-center rounded-md border border-border md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? t("nav.close") : t("nav.menu")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      <div
        id="mobile-nav"
        className={cx("border-t border-border bg-background md:hidden", !open && "hidden")}
      >
        <nav className="container-x flex flex-col gap-1 py-3" aria-label="Main">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-base hover:bg-muted"
            >
              {l.label}
            </a>
          ))}
          <a
            href={`${APP_URL}/login`}
            className="rounded-md px-2 py-2 text-base text-muted-foreground hover:bg-muted"
          >
            {t("nav.sign_in")}
          </a>
          <div className="mt-2 flex items-center justify-between gap-3 px-2">
            <LocaleSwitch current={locale} label={t("nav.language")} />
            <a href={demo} className={buttonClass("primary", "md")} {...external(demo)}>
              {t("nav.cta")}
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}

function external(href: string) {
  return href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {};
}

export function LocaleSwitch({
  current,
  label,
  className,
}: {
  current: LandingLocale;
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cx(
        "flex items-center gap-1 rounded-md border border-border p-0.5 text-xs",
        className,
      )}
    >
      {LANDING_LOCALES.map((l) => (
        <Link
          key={l}
          href={localePath(l)}
          hrefLang={l}
          lang={l}
          aria-current={l === current ? "page" : undefined}
          className={cx(
            "rounded px-2 py-1 transition-colors",
            l === current
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LOCALE_NAMES[l]}
        </Link>
      ))}
    </nav>
  );
}
