"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { MANUAL_LIFECYCLE_REASONS, PLAN_KEYS } from "@keel/config";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, Select, Switch, Textarea } from "@keel/ui";
import { markInvoicePaidAction, openAsSupportAction, sendPasswordResetAction, setAddonAction, setPlanAction, setTrialEndAction, transitionTenantAction, voidInvoiceAction } from "@/server/actions/admin";

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

/** Lifecycle change (#48): target state, reason and note are required; the dialog lists only the allowed moves. */
export function LifecycleControl({ tenantId, allowed }: { tenantId: string; allowed: readonly string[] }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(allowed[0] ?? "");
  const [reason, setReason] = useState<string>(MANUAL_LIFECYCLE_REASONS[0]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!allowed.length) return null;
  const submit = () =>
    start(async () => {
      const r = await transitionTenantAction(tenantId, { to, reason, note });
      if (!r.ok) return setError(r.error === "invalid_input" ? t("lifecycle.errors.invalid_input") : r.error === "invalid_transition" ? t("lifecycle.errors.invalid_transition") : t("lifecycle.errors.failed"));
      setOpen(false);
      setNote("");
      router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="change-lifecycle">{t("lifecycle.change")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("lifecycle.change_title")}</DialogTitle>
          <DialogDescription>{t("lifecycle.change_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lc-to">{t("lifecycle.to")}</Label>
            <Select id="lc-to" value={to} onChange={(e) => setTo(e.target.value)} data-testid="lifecycle-to">
              {allowed.map((s) => <option key={s} value={s}>{t(`tenants.status.${s}`)}</option>)}
            </Select>
            {(to === "suspended" || to === "churned") && <p className="text-xs text-destructive">{t("lifecycle.blocks_access")}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-reason">{t("lifecycle.reason")}</Label>
            <Select id="lc-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="lifecycle-reason">
              {MANUAL_LIFECYCLE_REASONS.map((r) => <option key={r} value={r}>{t(`lifecycle.reasons.${r}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-note">{t("lifecycle.note")}</Label>
            <Textarea id="lc-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} required data-testid="lifecycle-note" />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("lifecycle.cancel")}</Button>
          <Button variant={to === "suspended" || to === "churned" ? "destructive" : "default"} disabled={pending || note.trim().length < 3} onClick={submit} data-testid="confirm-lifecycle">{t("lifecycle.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Extends or shortens the trial (audited); the trialing subscription's first period follows. */
export function TrialEndControl({ tenantId, value }: { tenantId: string; value: string }) {
  const t = useTranslations("admin.lifecycle");
  const router = useRouter();
  const [date, setDate] = useState(value);
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input size="sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("trial_end")} className="w-40" data-testid="trial-end" />
      <Button size="sm" variant="outline" disabled={pending || !date || date === value} onClick={() => start(async () => { await setTrialEndAction(tenantId, date, ""); router.refresh(); })}>{t("save_trial_end")}</Button>
    </span>
  );
}

export function InvoiceActions({ invoiceId, status, provider }: { invoiceId: string; status: string; provider?: string }) {
  const t = useTranslations("admin.billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  // Stripe invoices are settled in Stripe and mirrored by webhooks (#53)
  if (status !== "open" || provider === "stripe") return null;
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
