"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@keel/ui";
import { closeAlertAction } from "@/server/actions/admin";

export function CloseAlertButton({ alertId }: { alertId: string }) {
  const t = useTranslations("admin.alerts");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="outline" disabled={pending} data-testid="close-alert" onClick={() => start(async () => { await closeAlertAction(alertId); router.refresh(); })}>
      {t("close")}
    </Button>
  );
}
