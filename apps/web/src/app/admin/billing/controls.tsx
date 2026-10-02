"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { runBillingAction } from "@/server/actions/admin";

export function BillingRunButton() {
  const t = useTranslations("admin.billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2 text-sm">
      {msg && <span className="text-muted-foreground">{msg}</span>}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await runBillingAction(); if (r.ok && r.data) setMsg(t("run_done", r.data)); router.refresh(); })}>{t("run")}</Button>
    </span>
  );
}
