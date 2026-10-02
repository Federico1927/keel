"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button, cn } from "@keel/ui";
import { syncCatalogAction } from "@/server/actions/product-edit";

/**
 * "Sync from Shopify" for the whole catalog (issue #19): the catalog run of `runCatalogSync`. With a
 * worker the job runs in the background and the page refreshes while it is running; without one the
 * button keeps resuming the run (each call works for a time budget) until it is finished.
 */
export function CatalogSyncButton({ slug, running, progress, lastSynced, canSync }: { slug: string; running: boolean; progress: string | null; lastSynced: string | null; canSync: boolean }) {
  const t = useTranslations("product_mirror.sync");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, router]);
  const sync = () =>
    start(async () => {
      setMsg(null);
      for (let i = 0; i < 30; i++) {
        const r = await syncCatalogAction(slug);
        if (!r.ok) {
          setMsg({ tone: "err", text: r.fieldErrors?.platform ? t("failed", { error: r.fieldErrors.platform }) : tc(`errors.${r.error}`) });
          break;
        }
        if (r.data?.queued) {
          setMsg({ tone: "ok", text: t("queued") });
          break;
        }
        setMsg({ tone: "ok", text: r.data?.finished ? t("catalog_done", { products: r.data.products }) : t("catalog_progress", { products: r.data?.products ?? 0 }) });
        if (r.data?.finished) break;
      }
      router.refresh();
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm" data-testid="catalog-sync">
      <span className="text-muted-foreground" data-testid="catalog-last-synced">{running && progress ? progress : lastSynced ? t("last", { when: lastSynced }) : t("never")}</span>
      {msg && <span className={msg.tone === "err" ? "text-destructive" : "text-muted-foreground"} data-testid="catalog-sync-result">{msg.text}</span>}
      {canSync && (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={sync} data-testid="sync-catalog-products">
          <RefreshCw className={cn("h-3.5 w-3.5", (pending || running) && "animate-spin")} /> {t("catalog")}
        </Button>
      )}
    </span>
  );
}
