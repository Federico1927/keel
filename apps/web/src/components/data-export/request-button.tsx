"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@keel/ui";
import { requestDataExportAction } from "@/server/actions/data-export";
import { requestTenantDataExportAction } from "@/server/actions/admin";

/** Starts a full data export (#32): the owner from the tenant settings, the super-admin from the console. */
export function RequestDataExportButton({ mode, target, disabled }: { mode: "owner" | "admin"; target: string; disabled?: boolean }) {
  const t = useTranslations("data_export");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        disabled={pending || disabled}
        data-testid="request-data-export"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = mode === "owner" ? await requestDataExportAction(target) : await requestTenantDataExportAction(target);
            if (!r.ok) setError(r.error === "in_progress" ? t("errors.in_progress") : t("errors.generic"));
            router.refresh();
          })
        }
      >
        {pending ? t("requesting") : t("request")}
      </Button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
