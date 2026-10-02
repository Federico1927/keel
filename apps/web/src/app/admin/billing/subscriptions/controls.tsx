"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { resyncBillingAction, syncCatalogAction } from "@/server/actions/admin-billing";

const ERRORS = ["provider_failed", "catalog_not_synced", "no_customer", "invalid_input"];

export function CatalogSyncButton({ mock }: { mock: boolean }) {
  const t = useTranslations("admin_billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      {msg && <span className="text-muted-foreground" role="status" data-testid="catalog-sync-result">{msg}</span>}
      <Button size="sm" variant="outline" disabled={pending} data-testid="sync-catalog" onClick={() => start(async () => { const r = await syncCatalogAction(); setMsg(r.ok && r.data ? t("sync_done", { ...r.data }) : t(`errors.${!r.ok && ERRORS.includes(r.error) ? r.error : "failed"}`)); router.refresh(); })}>{mock ? t("sync_catalog_mock") : t("sync_catalog")}</Button>
    </span>
  );
}

export function TenantResyncButton({ tenantId }: { tenantId: string }) {
  const t = useTranslations("admin_billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center justify-end gap-2">
      {msg && <span className="text-xs text-muted-foreground" role="status">{msg}</span>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await resyncBillingAction(tenantId); setMsg(r.ok ? t("resync_done", { invoices: r.data?.invoices ?? 0 }) : t(`errors.${ERRORS.includes(r.error) ? r.error : "failed"}`)); router.refresh(); })}>{t("resync")}</Button>
    </span>
  );
}
