"use client";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@hullwise/ui";
import { exitImpersonationAction } from "@/server/actions/admin";

/**
 * Support mode (#48): a super-admin inside a tenant sees the platform colour on every page (a band
 * with the tenant name and "Exit", plus a frame around the viewport), so a tenant is never mistaken
 * for the console. Exit is audited and returns to /admin.
 */
export function ImpersonationBanner({ tenantName, slug }: { tenantName: string; slug: string }) {
  const t = useTranslations("shell");
  const [pending, start] = useTransition();
  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-50 border-4 border-platform" aria-hidden />
      <div role="status" data-testid="impersonation-banner" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-platform px-4 py-2 text-sm text-platform-foreground">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span className="font-semibold uppercase tracking-wide">{t("support_mode")}</span>
        <span className="min-w-0 flex-1">{t.rich("impersonating", { tenant: tenantName, b: (c) => <strong>{c}</strong> })}</span>
        <Button size="sm" variant="outline" className="border-platform-foreground/60 bg-transparent text-platform-foreground hover:bg-platform-foreground/10 hover:text-platform-foreground" disabled={pending} data-testid="exit-impersonation" onClick={() => start(async () => { await exitImpersonationAction(slug); })}>
          <LogOut className="h-4 w-4" /> {t("exit_impersonation")}
        </Button>
      </div>
    </>
  );
}
