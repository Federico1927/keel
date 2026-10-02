import { getLocale, getTranslations } from "next-intl/server";
import { MODULES, PLANS, PLAN_KEYS, PLATFORM_CURRENCY, isAddonModule } from "@keel/config";
import { billingCatalog, formatDate, formatDateTime, formatMoney } from "@keel/core";
import type { Database } from "@keel/db";
import { billingSettings, tenantSubscriptionDetail } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";
import { CopyField } from "@/components/mcp/copy-field";
import { BillingModeBadge } from "../../_components/billing-mode";
import { StartSubscriptionDialog, SubscriptionActions } from "./billing-controls";

/** Console tenant page, Stripe side (#53): subscription mirror, pending checkout, start / resync / simulate. The page has called requireSuperAdmin(). */
export async function SubscriptionCard({ db, tenantId, planKey }: { db: Database; tenantId: string; planKey: string }) {
  const settings = billingSettings();
  const d = await tenantSubscriptionDetail(db, tenantId, settings);
  const t = await getTranslations("admin_billing");
  const tm = await getTranslations("modules");
  const locale = await getLocale();
  const s = d.subscription;
  const money = (m: number) => formatMoney(m, PLATFORM_CURRENCY, locale);
  const addons = Object.values(MODULES).filter((m) => isAddonModule(m.key) && m.availability === "implemented" && m.monthlyPriceMinor).map((m) => ({ key: m.key, label: `${tm(`addon.${m.key.replace("addon.", "")}.name`)} · ${money(m.monthlyPriceMinor!)}/m` }));
  const names = Object.fromEntries(billingCatalog().map((c) => [c.lookupKey, c.name]));
  const mock = settings.provider === "mock";
  return (
    <Card className="mt-6" data-testid="subscription-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">{t("card_title")} <BillingModeBadge mode={settings.mode} label={t(`mode.${settings.mode}`)} /></span>
          {!d.managed && <StartSubscriptionDialog tenantId={tenantId} planKey={planKey} activeAddons={d.activeAddons} addons={addons} setupFees={Object.fromEntries(PLAN_KEYS.map((p) => [p, money(PLANS[p].setupFeeMinor)]))} defaultEmail={d.defaultEmail} />}
        </CardTitle>
        <CardDescription>{t("card_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {d.drift && <Alert variant="warning" data-testid="subscription-drift"><AlertDescription>{t("drift")}</AlertDescription></Alert>}
        {s?.checkoutUrl && (
          <div className="space-y-1.5" data-testid="checkout-pending">
            <p className="font-medium">{t("checkout_pending")}{s.checkoutExpiresAt ? <span className="ml-2 text-xs font-normal text-muted-foreground">{t("expires", { date: formatDateTime(s.checkoutExpiresAt, locale, "UTC") })}</span> : null}</p>
            <CopyField value={s.checkoutUrl} />
          </div>
        )}
        {s?.externalSubscriptionId ? (
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t("status")}</dt>
            <dd><Badge variant={s.externalStatus === "active" ? "success" : s.externalStatus === "trialing" ? "info" : s.externalStatus === "past_due" || s.externalStatus === "unpaid" ? "warning" : "muted"} data-testid="external-status">{t(`external.${s.externalStatus ?? "incomplete"}`)}</Badge>{s.cancelAtPeriodEnd && <span className="ml-2 text-xs text-muted-foreground">{t("cancel_at_period_end")}</span>}</dd>
            <dt className="text-muted-foreground">{t("collection_label")}</dt>
            <dd>{t(`collection.${s.collectionMethod === "send_invoice" ? "send_invoice" : "charge_automatically"}`)}{s.paymentMethodSummary ? ` · ${s.paymentMethodSummary}` : ""}</dd>
            <dt className="text-muted-foreground">{t("items")}</dt>
            <dd><ul>{s.items.map((i) => <li key={i.itemId}>{(i.lookupKey && names[i.lookupKey]) ?? i.priceId} · {formatMoney(i.unitAmountMinor * i.quantity, i.currency, locale)}{i.interval ? "/m" : ""}</li>)}</ul></dd>
            <dt className="text-muted-foreground">{t("period_end")}</dt>
            <dd>{formatDate(s.currentPeriodEnd, locale, "UTC")}</dd>
            <dt className="text-muted-foreground">{t("customer")}</dt>
            <dd className="break-all font-mono text-xs">{s.externalCustomerId}{s.billingEmail ? ` · ${s.billingEmail}` : ""}{s.customerCountry ? ` · ${s.customerCountry}` : ""}{d.vat !== "unknown" ? ` · ${t(`vat.${d.vat}`)}` : ""}</dd>
            <dt className="text-muted-foreground">{t("synced")}</dt>
            <dd>{s.lastSyncedAt ? formatDateTime(s.lastSyncedAt, locale, "UTC") : "—"}</dd>
          </dl>
        ) : (
          !s?.checkoutUrl && <p className="text-muted-foreground" data-testid="no-processor-subscription">{t("none")}</p>
        )}
        {!d.catalogReady && !mock && <p className="text-xs text-muted-foreground">{t("catalog_missing")}</p>}
        <SubscriptionActions tenantId={tenantId} managed={d.managed} mock={mock} checkoutPending={Boolean(s?.checkoutSessionId)} />
        {mock && <p className="text-xs text-muted-foreground">{t("simulate_hint")}</p>}
      </CardContent>
    </Card>
  );
}
