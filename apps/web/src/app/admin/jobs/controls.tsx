"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { runJobNowAction } from "@/server/actions/admin";

/** "Run now" on a job type (and tenant): queued or run inline, audited (#32). */
export function RunNowButton({ jobType, tenantId }: { jobType: string; tenantId: string | null }) {
  const t = useTranslations("admin.jobs");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button size="sm" variant="outline" disabled={pending} data-testid="run-now" onClick={() => start(async () => { const r = await runJobNowAction(jobType, tenantId); setMsg(r.ok ? (r.data?.queued ? t("queued") : t("started_inline")) : t("not_runnable")); router.refresh(); })}>
        {t("run_now")}
      </Button>
      {msg && <span className="text-xs text-muted-foreground" role="status">{msg}</span>}
    </span>
  );
}
