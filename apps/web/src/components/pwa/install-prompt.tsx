"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, X } from "lucide-react";
import { PRODUCT_NAME } from "@hullwise/config";
import { Button } from "@hullwise/ui";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED = "pwa.install-dismissed";

/**
 * "Install the app" card on phones (#49), shown when the browser offers installation and the user
 * has not dismissed it. The dismissal is a per-device convenience kept in localStorage.
 */
export function InstallPrompt() {
  const t = useTranslations("mobile.pwa");
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      try {
        if (localStorage.getItem(DISMISSED)) return;
      } catch {
        // storage blocked: still offer it
      }
      setEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  if (!event) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      // ignore
    }
    setEvent(null);
  };
  return (
    <div role="dialog" aria-label={t("install_title", { product: PRODUCT_NAME })} className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-lg border bg-card p-3 shadow-lg md:inset-x-auto md:right-4 md:w-96 lg:bottom-4" data-testid="install-prompt">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("install_title", { product: PRODUCT_NAME })}</p>
        <p className="text-xs text-muted-foreground">{t("install_body")}</p>
      </div>
      <Button size="sm" onClick={async () => { await event.prompt(); await event.userChoice.catch(() => null); setEvent(null); }}>
        <Download /> {t("install")}
      </Button>
      <Button size="icon" variant="ghost" onClick={dismiss} aria-label={t("dismiss")}><X /></Button>
    </div>
  );
}
