"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { restartHistoryImportAction } from "@/server/actions/integrations";

/** Restart the order history import with the window set in Settings → Operational (the running one is rewound). */
export function HistoryImportRestart({ slug, months }: { slug: string; months: number }) {
  const t = useTranslations("integrations.history_import");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <ConfirmButton size="sm" variant="outline" disabled={pending} title={t("restart_title")} description={months > 0 ? t("restart_description", { months }) : t("restart_description_all")} confirmLabel={t("restart")} data-testid="history-import-restart"
        onConfirm={() => start(async () => { const r = await restartHistoryImportAction(slug); if (r.ok) { setDone(true); router.refresh(); } })}>
        {t("restart")}
      </ConfirmButton>
      {done && <span className="text-muted-foreground" data-testid="history-import-restarted">{t("restarted")}</span>}
    </div>
  );
}
