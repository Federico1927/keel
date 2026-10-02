"use client";
import { Monitor } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@hullwise/ui";

/**
 * "Better on a larger screen" (#49, Tier 3): shown on phones above editors that are impractical
 * there (dashboard layout, state rules, planning grids). The page stays readable and its simple
 * actions keep working; the notice only sets expectations.
 */
export function DesktopNotice({ className, children }: { className?: string; children?: React.ReactNode }) {
  const t = useTranslations("mobile.desktop_notice");
  return (
    <p role="note" className={cn("mb-4 flex items-start gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm md:hidden", className)} data-testid="desktop-notice">
      <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
      <span><span className="font-medium">{t("title")}</span> {children ?? t("body")}</span>
    </p>
  );
}
