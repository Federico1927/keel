import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PLATFORM_CURRENCY, UPCOMING_RENEWAL_DAYS } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney } from "@hullwise/core";
import { consoleBillingOverview } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingModeBadge } from "../../_components/billing-mode";
import { CatalogSyncButton, TenantResyncButton } from "./controls";

/** Console → Billing → Subscriptions (#53): what Stripe collects, from the webhook mirror. */
export default async function AdminSubscriptionsPage() {
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.tenant")}</TableHead>
                  <TableHead>{t("table.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("table.collection")}</TableHead>
                  <TableHead className="text-right">{t("table.monthly")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("table.period_end")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("table.synced")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.subscriptions.map((r) => (
                  <TableRow key={r.tenantId} data-testid="subscription-row">
                    <TableCell><Link href={`/admin/tenants/${r.tenantId}`} className="font-medium hover:underline">{r.tenantName}</Link><div className="text-xs text-muted-foreground">{tl(`plans.${r.planKey}`)}{r.vat !== "unknown" ? ` · ${t(`vat.${r.vat}`)}` : ""}</div></TableCell>
                    <TableCell><Badge variant={r.externalStatus === "active" ? "success" : r.externalStatus === "trialing" ? "info" : r.externalStatus === "past_due" || r.externalStatus === "unpaid" ? "warning" : "muted"}>{t(`external.${r.externalStatus ?? "incomplete"}`)}</Badge></TableCell>
                    <TableCell className="hidden md:table-cell">{t(`collection.${r.collectionMethod === "send_invoice" ? "send_invoice" : "charge_automatically"}`)}</TableCell>
                    <TableCell className="text-right tabular">{money(r.monthlyMinor, r.currency)}</TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(r.currentPeriodEnd, locale, "UTC")}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{r.lastSyncedAt ? formatDateTime(r.lastSyncedAt, locale, "UTC") : "—"}</TableCell>
                    <TableCell>{r.provider === "stripe" && <TenantResyncButton tenantId={r.tenantId} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("catalog_title")}</CardTitle><CardDescription>{t("catalog_description")}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("catalog_columns.item")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("catalog_columns.lookup_key")}</TableHead>
                <TableHead className="text-right">{t("catalog_columns.amount")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("catalog_columns.price")}</TableHead>
                <TableHead>{t("catalog_columns.synced")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.catalog.map((c) => (
                <TableRow key={c.lookupKey} data-testid="catalog-row">
                  <TableCell>{c.name}<div className="text-xs text-muted-foreground">{t(`kind.${c.kind}`)}</div></TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">{c.lookupKey}</TableCell>
                  <TableCell className="text-right tabular">{money(c.amountMinor, c.currency)}{c.interval ? "/m" : ""}</TableCell>
                  <TableCell className="hidden break-all font-mono text-xs lg:table-cell">{c.priceId ?? "—"}</TableCell>
                  <TableCell><Badge variant={c.inStep ? "success" : "warning"} className="whitespace-nowrap">{c.inStep ? t("in_step") : t("out_of_step")}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
