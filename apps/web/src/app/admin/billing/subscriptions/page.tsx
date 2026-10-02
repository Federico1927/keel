import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PLATFORM_CURRENCY, UPCOMING_RENEWAL_DAYS } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney } from "@hullwise/core";
import { consoleBillingOverview } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, DataList, PageHeader, Stat } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingModeBadge } from "../../_components/billing-mode";
import { CatalogSyncButton, TenantResyncButton } from "./controls";

import { withIntl } from "@/i18n/intl-scope";
/** Console → Billing → Subscriptions (#53): what Stripe collects, from the webhook mirror. */
async function AdminSubscriptionsPage() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin_billing");
  const tl = await getTranslations("admin");
  const locale = await getLocale();
  const now = new Date();
  const o = await consoleBillingOverview(db, now);
  const s = o.settings;
  const money = (m: number, c = PLATFORM_CURRENCY) => formatMoney(m, c, locale);
  return (
    <>
      <PageHeader eyebrow={tl("console")} title={t("subscriptions_title")} description={t("subscriptions_description")} actions={<><BillingModeBadge mode={s.mode} label={t(`mode.${s.mode}`)} /><CatalogSyncButton mock={s.provider === "mock"} /></>} />
      {s.provider === "mock" && <Alert variant="info" className="mb-4" data-testid="stripe-not-configured"><AlertDescription>{t("not_configured")}</AlertDescription></Alert>}
      {s.provider === "stripe" && !s.webhookConfigured && <Alert variant="warning" className="mb-4"><AlertDescription>{t("webhook_missing")}</AlertDescription></Alert>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t("mrr")} value={<span data-testid="mirrored-mrr">{money(o.mrrMinor)}</span>} hint={t("mrr_hint", { n: o.managedCount })} />
        <Stat label={t("failed_payments")} value={o.failedPayments.length} />
        <Stat label={t("past_due")} value={o.pastDue.length} />
        <Stat label={t("last_webhook")} value={<span className="text-base" data-testid="last-webhook">{o.lastEvent ? formatDateTime(o.lastEvent.receivedAt, locale, "UTC") : t("no_webhook")}</span>} hint={o.lastEvent ? `${o.lastEvent.type}${o.failedEvents ? ` · ${t("failed_events", { n: o.failedEvents })}` : ""}` : undefined} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("failed_payments")}</CardTitle></CardHeader>
          <CardContent>
            {o.failedPayments.length === 0 ? <p className="text-sm text-muted-foreground">{t("nothing")}</p> : (
              <ul className="divide-y text-sm" data-testid="failed-payments">
                {o.failedPayments.map((f) => (
                  <li key={`${f.tenantId}-${f.number}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0"><Link href={`/admin/tenants/${f.tenantId}`} className="font-medium hover:underline">{f.tenantName}</Link> <span className="font-mono text-xs text-muted-foreground">{f.number}</span>
                      <span className="block text-xs text-muted-foreground">{f.actionRequired ? t("action_required") : t("attempts", { n: f.attemptCount })}{f.nextAttemptAt ? ` · ${t("next_attempt", { date: formatDate(f.nextAttemptAt, locale, "UTC") })}` : ""}</span></span>
                    <span className="tabular">{money(f.amountMinor, f.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("past_due")}</CardTitle></CardHeader>
          <CardContent>
            {o.pastDue.length === 0 ? <p className="text-sm text-muted-foreground">{t("nothing")}</p> : (
              <ul className="divide-y text-sm" data-testid="past-due-tenants">
                {o.pastDue.map((p) => (
                  <li key={p.tenantId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/admin/tenants/${p.tenantId}`} className="font-medium hover:underline">{p.tenantName}</Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant={p.status === "suspended" ? "destructive" : "warning"}>{tl(`tenants.status.${p.status}`)}</Badge>{t("days_overdue", { n: p.daysOverdue, limit: p.suspendAfterDays })}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("renewals")}</CardTitle><CardDescription>{t("renewals_hint", { days: UPCOMING_RENEWAL_DAYS })}</CardDescription></CardHeader>
          <CardContent>
            {o.renewals.length === 0 ? <p className="text-sm text-muted-foreground">{t("nothing")}</p> : (
              <ul className="divide-y text-sm">
                {o.renewals.map((r) => (
                  <li key={r.tenantId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><Link href={`/admin/tenants/${r.tenantId}`} className="font-medium hover:underline">{r.tenantName}</Link> <span className="text-xs text-muted-foreground">{formatDate(r.at, locale, "UTC")}{r.cancelAtPeriodEnd ? ` · ${t("cancel_at_period_end")}` : ""}</span></span>
                    <span className="tabular">{money(r.monthlyMinor, r.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">{t("tax_title")} · {t("einvoicing_title")} <Badge variant="warning">{t("verify_badge")}</Badge></CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{s.automaticTax || s.provider === "mock" ? t("tax_automatic") : t("tax_manual", { country: s.sellerCountry ?? "—" })}</p>
            <p className="text-muted-foreground">{t("einvoicing_body")}</p>
            <p className="text-xs"><Badge variant="outline">{t(`einvoicing_state.${s.einvoicing}`)}</Badge></p>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("subscriptions_table")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {o.subscriptions.length === 0 ? <EmptyState title={t("empty")} /> : (
            <DataList
              rows={o.subscriptions}
              rowKey={(r) => r.tenantId}
              rowProps={() => ({ "data-testid": "subscription-row" })}
              columns={[
                { key: "tenant", header: t("table.tenant"), mobile: "title", cell: (r) => <><Link href={`/admin/tenants/${r.tenantId}`} className="font-medium hover:underline">{r.tenantName}</Link><div className="text-xs font-normal text-muted-foreground">{tl(`plans.${r.planKey}`)}{r.vat !== "unknown" ? ` · ${t(`vat.${r.vat}`)}` : ""}</div></> },
                { key: "status", header: t("table.status"), mobile: "badge", cell: (r) => <Badge variant={r.externalStatus === "active" ? "success" : r.externalStatus === "trialing" ? "info" : r.externalStatus === "past_due" || r.externalStatus === "unpaid" ? "warning" : "muted"}>{t(`external.${r.externalStatus ?? "incomplete"}`)}</Badge> },
                { key: "collection", header: t("table.collection"), priority: 2, cell: (r) => t(`collection.${r.collectionMethod === "send_invoice" ? "send_invoice" : "charge_automatically"}`) },
                { key: "monthly", header: t("table.monthly"), align: "right", className: "tabular", cell: (r) => money(r.monthlyMinor, r.currency) },
                { key: "period_end", header: t("table.period_end"), cell: (r) => formatDate(r.currentPeriodEnd, locale, "UTC") },
                { key: "synced", header: t("table.synced"), priority: 3, className: "text-xs text-muted-foreground", cell: (r) => (r.lastSyncedAt ? formatDateTime(r.lastSyncedAt, locale, "UTC") : "—") },
                { key: "resync", header: null, mobile: "action", cell: (r) => (r.provider === "stripe" ? <TenantResyncButton tenantId={r.tenantId} /> : null) },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("catalog_title")}</CardTitle><CardDescription>{t("catalog_description")}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={o.catalog}
            rowKey={(c) => c.lookupKey}
            rowProps={() => ({ "data-testid": "catalog-row" })}
            columns={[
              { key: "item", header: t("catalog_columns.item"), mobile: "title", cell: (c) => <>{c.name}<div className="text-xs font-normal text-muted-foreground">{t(`kind.${c.kind}`)}</div></> },
              { key: "synced", header: t("catalog_columns.synced"), mobile: "badge", cell: (c) => <Badge variant={c.inStep ? "success" : "warning"} className="whitespace-nowrap">{c.inStep ? t("in_step") : t("out_of_step")}</Badge> },
              { key: "lookup", header: t("catalog_columns.lookup_key"), priority: 2, className: "break-all font-mono text-xs", cell: (c) => c.lookupKey },
              { key: "amount", header: t("catalog_columns.amount"), align: "right", className: "tabular", cell: (c) => `${money(c.amountMinor, c.currency)}${c.interval ? "/m" : ""}` },
              { key: "price", header: t("catalog_columns.price"), priority: 3, className: "break-all font-mono text-xs", cell: (c) => c.priceId ?? "—" },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminSubscriptionsPage, "app/admin/billing/subscriptions/page.tsx");
