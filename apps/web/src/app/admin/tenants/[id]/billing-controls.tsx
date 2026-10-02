"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { DEFAULT_PAYMENT_TERMS_DAYS, PLAN_KEYS } from "@keel/config";
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, Select } from "@keel/ui";
import { CopyField } from "@/components/mcp/copy-field";
import { resyncBillingAction, simulateBillingAction, startSubscriptionAction } from "@/server/actions/admin-billing";

const ERRORS = ["provider_failed", "catalog_not_synced", "already_subscribed", "invalid_input", "no_customer", "no_checkout", "not_mock", "not_managed", "no_subscription", "tenant_not_found"];

/** Console "Start subscription" (#53): plan, add-ons, setup fee, trial, billing email, card (Checkout link, emailed) or bank transfer. */
export function StartSubscriptionDialog({ tenantId, planKey, activeAddons, addons, setupFees, defaultEmail }: { tenantId: string; planKey: string; activeAddons: string[]; addons: { key: string; label: string }[]; setupFees: Record<string, string>; defaultEmail: string }) {
  const t = useTranslations("admin_billing");
  const tp = useTranslations("admin.plans");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState(planKey);
  const [chosen, setChosen] = useState<string[]>(activeAddons.filter((a) => addons.some((x) => x.key === a)));
  const [setup, setSetup] = useState(true);
  const [trial, setTrial] = useState("0");
  const [email, setEmail] = useState(defaultEmail);
  const [collection, setCollection] = useState<"checkout" | "invoice">("checkout");
  const [terms, setTerms] = useState(String(DEFAULT_PAYMENT_TERMS_DAYS));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url?: string; email?: string; invoice?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      setError(null);
      const r = await startSubscriptionAction(tenantId, { planKey: plan as (typeof PLAN_KEYS)[number], addons: chosen, chargeSetupFee: setup, trialDays: Number(trial) || 0, billingEmail: email, collection, paymentTermsDays: collection === "invoice" ? Number(terms) || DEFAULT_PAYMENT_TERMS_DAYS : undefined });
      if (!r.ok) return setError(t(`errors.${ERRORS.includes(r.error) ? r.error : "failed"}`));
      setResult(r.data?.kind === "checkout" ? { url: r.data.url, email: r.data.email } : { invoice: true });
      router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setResult(null); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="start-subscription">{t("start")}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("start_title")}</DialogTitle>
          <DialogDescription>{t("start_description")}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 text-sm" data-testid="start-result">
            {result.url ? (
              <>
                <p className="font-medium">{t("link_ready")}</p>
                <CopyField value={result.url} testId="checkout-url" />
                <p className="text-muted-foreground" data-testid="checkout-email">{result.email === "queued" ? t("email_sent", { email }) : t("email_not_sent", { reason: result.email ?? "" })}</p>
              </>
            ) : (
              <p>{t("invoice_started")}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ss-plan">{t("plan")}</Label>
                <Select id="ss-plan" value={plan} onChange={(e) => setPlan(e.target.value)} data-testid="ss-plan">
                  {PLAN_KEYS.map((p) => <option key={p} value={p}>{tp(p)}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ss-trial">{t("trial_days")}</Label>
                <Input id="ss-trial" type="number" min={0} max={365} value={trial} onChange={(e) => setTrial(e.target.value)} />
              </div>
            </div>
            {addons.length > 0 && (
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">{t("addons")}</legend>
                {addons.map((a) => (
                  <label key={a.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={chosen.includes(a.key)} onCheckedChange={(v) => setChosen((c) => (v ? [...c, a.key] : c.filter((x) => x !== a.key)))} aria-label={a.label} />
                    {a.label}
                  </label>
                ))}
              </fieldset>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={setup} onCheckedChange={(v) => setSetup(v === true)} aria-label={t("setup_fee", { amount: setupFees[plan] ?? "" })} />
              {t("setup_fee", { amount: setupFees[plan] ?? "" })}
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="ss-email">{t("billing_email")}</Label>
              <Input id="ss-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="ss-email" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ss-collection">{t("collection_label")}</Label>
                <Select id="ss-collection" value={collection} onChange={(e) => setCollection(e.target.value as "checkout" | "invoice")}>
                  <option value="checkout">{t("collection_checkout")}</option>
                  <option value="invoice">{t("collection_invoice")}</option>
                </Select>
              </div>
              {collection === "invoice" && (
                <div className="space-y-1.5">
                  <Label htmlFor="ss-terms">{t("terms_days")}</Label>
                  <Input id="ss-terms" type="number" min={1} max={120} value={terms} onChange={(e) => setTerms(e.target.value)} />
                </div>
              )}
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{result ? t("close") : t("cancel")}</Button>
          {!result && <Button disabled={pending || !email.trim()} onClick={submit} data-testid="confirm-start-subscription">{t("submit")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Resync from Stripe, and in mock mode the simulated webhooks. */
export function SubscriptionActions({ tenantId, managed, mock, checkoutPending }: { tenantId: string; managed: boolean; mock: boolean; checkoutPending: boolean }) {
  const t = useTranslations("admin_billing");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true; data?: { processed?: number; invoices?: number } } | { ok: false; error: string }>, done: (d: { processed?: number; invoices?: number }) => string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? done(r.data ?? {}) : t(`errors.${ERRORS.includes(r.error) ? r.error : "failed"}`));
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {managed && !mock && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => resyncBillingAction(tenantId), (d) => t("resync_done", { invoices: d.invoices ?? 0 }))} data-testid="resync-billing">{t("resync")}</Button>}
      {mock && checkoutPending && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => simulateBillingAction(tenantId, "checkout"), (d) => t("simulated", { n: d.processed ?? 0 }))} data-testid="simulate-checkout">{t("simulate_checkout")}</Button>}
      {mock && managed && (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => simulateBillingAction(tenantId, "renewal"), (d) => t("simulated", { n: d.processed ?? 0 }))}>{t("simulate_renewal")}</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => simulateBillingAction(tenantId, "renewal_failed"), (d) => t("simulated", { n: d.processed ?? 0 }))} data-testid="simulate-failed">{t("simulate_failed")}</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => simulateBillingAction(tenantId, "payment"), (d) => t("simulated", { n: d.processed ?? 0 }))}>{t("simulate_payment")}</Button>
        </>
      )}
      {msg && <span className="text-xs text-muted-foreground" role="status">{msg}</span>}
    </div>
  );
}
