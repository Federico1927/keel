"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { PLAN_KEYS } from "@keel/config";
import { Button, Input, Select, Switch } from "@keel/ui";
import { markInvoicePaidAction, openAsSupportAction, sendPasswordResetAction, setAddonAction, setPlanAction, setSuspensionAction, voidInvoiceAction } from "@/server/actions/admin";

export function OpenAsSupportButton({ tenantId }: { tenantId: string }) {
  const t = useTranslations("admin.tenant");
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await openAsSupportAction(tenantId); })}>
      {t("open_as_support")}
    </Button>
  );
}

export function AddonToggle({ tenantId, moduleKey, active, available }: { tenantId: string; moduleKey: string; active: boolean; available: boolean }) {
  const t = useTranslations("admin.tenant");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Switch checked={active} disabled={!available || pending} aria-label={moduleKey} data-testid={`addon-${moduleKey}`} onCheckedChange={(v) => start(async () => { await setAddonAction(tenantId, moduleKey, v, note || null); router.refresh(); })} />
      {available && <Input size="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("addon_note")} className="w-44" />}
    </div>
  );
}

export function PlanSelect({ tenantId, planKey }: { tenantId: string; planKey: string }) {
  const tp = useTranslations("admin.plans");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Select size="sm" value={planKey} disabled={pending} className="w-40" aria-label="plan" onChange={(e) => start(async () => { await setPlanAction(tenantId, e.target.value); router.refresh(); })}>
      {PLAN_KEYS.map((p) => <option key={p} value={p}>{tp(p)}</option>)}
    </Select>
  );
}

export function SuspensionButton({ tenantId, suspended }: { tenantId: string; suspended: boolean }) {
  const t = useTranslations("admin.tenant");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant={suspended ? "default" : "destructive"} disabled={pending} onClick={() => start(async () => { await setSuspensionAction(tenantId, !suspended, null); router.refresh(); })}>
      {suspended ? t("reactivate") : t("suspend")}
    </Button>
  );
}

export function InvoiceActions({ invoiceId, status }: { invoiceId: string; status: string }) {
  const t = useTranslations("admin.billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  if (status !== "open") return null;
  return (
    <span className="flex justify-end gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markInvoicePaidAction(invoiceId); router.refresh(); })}>{t("mark_paid")}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await voidInvoiceAction(invoiceId); router.refresh(); })}>{t("void")}</Button>
    </span>
  );
}

/** Sends the person the "Forgot password?" email (#52); the console never sees the link. */
export function SendPasswordResetButton({ userId }: { userId: string }) {
  const t = useTranslations("admin.tenant");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {result && <span className="text-xs text-muted-foreground" role="status">{result}</span>}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        data-testid="send-password-reset"
        onClick={() =>
          start(async () => {
            const r = await sendPasswordResetAction(userId);
            setResult(r.ok ? (r.data?.sent ? t("reset_sent") : t("reset_not_active")) : r.error === "rate_limited" ? t("reset_rate_limited") : t("reset_failed"));
          })
        }
      >
        {t("send_password_reset")}
      </Button>
    </span>
  );
}
