"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { syncInventoryNow } from "@/server/actions/platform-writes";

/** Re-reads stock from the commerce platform for every variant, with the run summary inline. */
export function SyncInventoryButton({ slug }: { slug: string }) {
  const t = useTranslations("inventory");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {msg && <span className={msg.tone === "err" ? "text-sm text-destructive" : "text-sm text-muted-foreground"} data-testid="inventory-sync-result">{msg.text}</span>}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        data-testid="inventory-sync-now"
        onClick={() =>
          start(async () => {
            const r = await syncInventoryNow(slug);
            if (!r.ok) setMsg({ tone: "err", text: r.fieldErrors?.platform ? t("sync_failed", { error: r.fieldErrors.platform }) : tc(`errors.${r.error}`) });
            else if (r.data?.queued) setMsg({ tone: "ok", text: t("sync_queued") });
            else if (r.data && !r.data.finished) setMsg({ tone: "ok", text: t("sync_paused") });
            else if (r.data) setMsg({ tone: "ok", text: t("sync_done", { changed: r.data.changed, drift: r.data.drift, conflicts: r.data.conflicts, zeroed: r.data.zeroed }) });
            router.refresh();
          })
        }
      >
        {t("sync_now")}
      </Button>
    </span>
  );
}
