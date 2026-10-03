"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Checkbox, Input, Label, Textarea } from "@hullwise/ui";
import { requestTenantDeletionAction, retryTenantDeletionAction } from "@/server/actions/admin-privacy";

/** The deletion form: the slug typed, plus the demo and no-export confirmations when they apply. */
export function DeleteTenantForm({ tenantId, slug, isDemo, exportDownloaded }: { tenantId: string; slug: string; isDemo: boolean; exportDownloaded: boolean }) {
  const t = useTranslations("privacy");
  const router = useRouter();
  const [value, setValue] = useState("");
  const [demo, setDemo] = useState(false);
  const [noExport, setNoExport] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = value.trim() === slug && (!isDemo || demo) && (exportDownloaded || noExport);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); start(async () => {
      setError(null);
      const r = await requestTenantDeletionAction(tenantId, { confirmSlug: value, confirmDemo: demo, withoutExport: noExport, reason });
      if (!r.ok) return setError(t.has(`delete.errors.${r.error}`) ? t(`delete.errors.${r.error as "generic"}`) : t("delete.errors.generic"));
      router.refresh();
    }); }}>
      <div className="space-y-1.5">
        <Label htmlFor="delete-slug">{t("delete.type_slug", { slug })}</Label>
        <Input id="delete-slug" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} data-testid="delete-slug" />
      </div>
      {!exportDownloaded && (
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={noExport} onCheckedChange={(v) => setNoExport(v === true)} data-testid="delete-without-export" className="mt-0.5" /><span>{t("delete.without_export")}</span></label>
      )}
      {isDemo && (
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={demo} onCheckedChange={(v) => setDemo(v === true)} data-testid="delete-confirm-demo" className="mt-0.5" /><span>{t("delete.confirm_demo")}</span></label>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="delete-reason">{t("delete.reason")}</Label>
        <Textarea id="delete-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert" data-testid="delete-error">{error}</p>}
      <Button type="submit" variant="destructive" disabled={!ready || pending} data-testid="delete-tenant">{pending ? t("delete.running") : t("delete.submit")}</Button>
    </form>
  );
}

/** Refreshes the page while the deletion job runs, so the progress moves without a reload. */
export function DeletionRefresher() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}

export function RetryDeletionButton({ deletionId }: { deletionId: string }) {
  const t = useTranslations("privacy");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button variant="outline" disabled={pending} data-testid="retry-deletion" onClick={() => start(async () => { await retryTenantDeletionAction(deletionId); router.refresh(); })}>{t("delete.retry")}</Button>;
}
