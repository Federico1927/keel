"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button } from "@keel/ui";
import { syncPayoutsAction } from "@/server/actions/payments";

/** One pass of the payouts sync (the daily job runs the same, resumable). */
export function SyncPayoutsButton({ slug }: { slug: string }) {
  const t = useTranslations("payouts");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={pending} data-testid="sync-payouts" onClick={() => start(async () => {
        const r = await syncPayoutsAction(slug);
        setMessage(r.ok ? t(r.data?.finished ? "synced" : "sync_paused", { payouts: r.data?.payouts ?? 0, transactions: r.data?.transactions ?? 0 }) : `${tc(`errors.${r.error}`)}${r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : ""}`);
        router.refresh();
      })}>
        <RefreshCw className={pending ? "animate-spin" : ""} /> {t("sync")}
      </Button>
      {message && <span className="text-xs text-muted-foreground" data-testid="sync-payouts-result">{message}</span>}
    </span>
  );
}
