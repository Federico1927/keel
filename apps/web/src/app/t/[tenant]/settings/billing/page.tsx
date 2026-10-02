import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { formatDate, formatMoney } from "@keel/core";
import { tenantBillingOverview } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { PortalButton } from "./portal-button";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("billing"))("title") };
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = { paid: "success", open: "warning", uncollectible: "destructive", void: "muted" };

/** Settings → Billing (#53), owners only: plan, add-ons, next invoice, payment status, invoices, the Stripe portal. */
export default async function BillingSettingsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  if (ctx.role !== "owner") notFound();
  const sp = await searchParams;
  const t = await getTranslations("billing");
  const ts = await getTranslations("settings");
  const tp = await getTranslations("plans");
  const tm = await getTranslations("modules");
  const now = new Date();
  const v = await ctx.run((tx) => tenantBillingOverview({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { planKey: ctx.tenant.planKey, status: ctx.tenant.status, suspendAfterDays: ctx.tenant.suspendAfterDays, activeAddons: ctx.activeAddons }, now));
  const money = (m: number, c = v.currency) => formatMoney(m, c, ctx.locale);
  const date = (d: Date) => formatDate(d, ctx.locale, ctx.tenant.timezone);
  const s = v.subscription;
  const checkout = typeof sp.checkout === "string" ? sp.checkout : null;
  const notice = sp.mock_portal ? t("portal_mock") : sp.mock_checkout ? t("checkout_mock") : checkout === "success" ? t("checkout_success") : checkout === "cancelled" ? t("checkout_cancelled") : null;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings`} className="hover:underline">← {ts("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      {notice && <Alert variant="info" className="mb-4" data-testid="billing-notice"><AlertDescription>{notice}</AlertDescription></Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="billing-plan">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">{t("plan_title")} <Badge variant="outline">{tp(v.planKey)}</Badge></CardTitle>
            <CardDescription>{t("plan_monthly", { amount: money(v.monthlyMinor) })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="font-medium">{t("addons_title")}</p>
              {v.addons.length === 0 ? <p className="text-muted-foreground">{t("no_addons")}</p> : (
                <ul className="mt-1 space-y-0.5">{v.addons.map((a) => <li key={a.key} className="flex justify-between gap-2"><span>{tm(`addon.${a.key.replace("addon.", "")}.name`)}</span><span className="tabular text-muted-foreground">{money(a.amountMinor)}</span></li>)}</ul>
              )}
            </div>
            <div className="flex justify-between gap-2 border-t pt-3">
              <span className="text-muted-foreground">{t("next_invoice")}</span>
              <span data-testid="next-invoice">{v.nextInvoiceAt ? t("next_invoice_value", { date: date(v.nextInvoiceAt), amount: money(v.monthlyMinor) }) : s?.cancelAtPeriodEnd ? t("cancel_at_period_end", { date: date(s.currentPeriodEnd) }) : "—"}</span>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="billing-payment">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">{t("payment_title")} <Badge variant={v.payment.health === "ok" ? "success" : v.payment.health === "none" ? "muted" : v.payment.health === "suspended" ? "destructive" : "warning"} data-testid="payment-status">{t(`payment_status.${v.payment.health}`)}</Badge></CardTitle>
            {v.payment.daysOverdue > 0 && <CardDescription>{t("days_overdue", { n: v.payment.daysOverdue })} · {money(v.payment.openMinor)}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{t("payment_method")}</span>
              <span>{s?.paymentMethodSummary ?? (s?.collectionMethod === "send_invoice" ? t("collection.send_invoice", { days: s.paymentTermsDays ?? 14 }) : t("payment_method_none"))}</span>
            </div>
            {v.managed ? (
              <>
                <PortalButton slug={tenant} />
                <p className="text-xs text-muted-foreground">{t("manage_payment_hint")}</p>
              </>
            ) : (
              <p className="text-muted-foreground" data-testid="billing-not-managed">{t("not_managed")}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle>{t("invoices_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {v.invoices.length === 0 ? <EmptyState title={t("invoices_empty")} /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.number")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("columns.date")}</TableHead>
                  <TableHead className="text-right">{t("columns.amount")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.document")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {v.invoices.map((i) => (
                  <TableRow key={i.id} data-testid="billing-invoice-row">
                    <TableCell className="font-mono text-xs">{i.number}<div className="font-sans text-xs text-muted-foreground sm:hidden">{date(i.issuedAt)}</div></TableCell>
                    <TableCell className="hidden sm:table-cell">{date(i.issuedAt)}</TableCell>
                    <TableCell className="text-right tabular">{money(i.amountMinor, i.currency)}</TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[i.status] ?? "muted"}>{t(`status.${i.status}`)}</Badge></TableCell>
                    <TableCell className="text-right">
                      <span className="flex justify-end gap-2">
                        {(i.status === "open" || i.status === "uncollectible") && i.hostedUrl && <a href={i.hostedUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{t("pay_now")}</a>}
                        <a href={`/t/${tenant}/settings/billing/invoices/${i.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline" data-testid="invoice-download">{t("download")}</a>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
