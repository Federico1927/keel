import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PAYMENT_METHODS, RATE_KEY_PATTERN, addDaysToKey, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { salesDayOrders } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant, runAnalytics } from "@/server/analytics";
import { Num, dayHref, dayLabel, rateText } from "../shared";

import { withIntl } from "@/i18n/intl-scope";
const KINDS = ["sale", "refund", "fee"] as const;

/**
 * One day of the daily sales summary (#85): its rows per tax rate, its fees per method, and the
 * orders behind its numbers, narrowed by kind, tax rate or payment method from the summary's links.
 */
async function DailySalesDayPage({ params, searchParams }: { params: Promise<{ tenant: string; day: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant, day } = await params;
  const sp = await searchParams;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) notFound();
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("daily_sales");
  const tp = await getTranslations("payment_methods");
  const ts = await getTranslations("order_status");
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as (typeof KINDS)[number]) : undefined;
  const rateKey = sp.rate && RATE_KEY_PATTERN.test(sp.rate) ? sp.rate : undefined;
  const method = (PAYMENT_METHODS as readonly string[]).includes(sp.method ?? "") ? sp.method : undefined;
  const filter = { kind, rateKey, method };
  const { summary, orders } = await runAnalytics(ctx, (s) => salesDayOrders(s, analyticsTenant(ctx), day, filter));
  const d = summary.days[0]!;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const rate = (k: string) => rateText(k, ctx.locale, (v) => t("rate_label", v));
  const filtered = Boolean(kind || rateKey || method);
  const filterLabel = rateKey ? t("day.rate_filter", { rate: rate(rateKey) }) : method ? t("day.method_filter", { method: tp(method) }) : kind ? t(`day.kinds.${kind}`) : null;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics/daily-sales`} className="hover:underline">← {t("title")}</Link></p>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("day.title", { day: dayLabel(day, ctx.locale, { dateStyle: "full" }) })}
        description={t("identity")}
        actions={
          <div className="flex gap-2">
            <Link href={dayHref(tenant, addDaysToKey(day, -1))} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5" aria-label={t("day.previous")}><ChevronLeft className="h-4 w-4" /> {t("day.previous")}</Link>
            <Link href={dayHref(tenant, addDaysToKey(day, 1))} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5" aria-label={t("day.next")}>{t("day.next")} <ChevronRight className="h-4 w-4" /></Link>
          </div>
        }
      />
      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t("rates_title")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {d.rates.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("day.no_sales")}</p>
            ) : (
              <DataList
                data-testid="day-rates"
                rows={d.rates}
                rowKey={(r) => r.rateKey}
                columns={[
                  { key: "rate", header: t("columns.rate"), mobile: "title", cell: (r) => <Link href={dayHref(tenant, day, { rate: r.rateKey })} className="font-medium hover:underline">{rate(r.rateKey)}</Link> },
                  { key: "gross", header: t("columns.gross"), align: "right", cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey, kind: "sale" })} value={r.grossSalesMinor}>{money(r.grossSalesMinor)}</Num> },
                  { key: "discounts", header: t("columns.discounts"), align: "right", cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey, kind: "sale" })} value={r.discountsMinor}>{money(r.discountsMinor)}</Num> },
                  { key: "refunds", header: t("columns.refunds"), align: "right", cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey, kind: "refund" })} value={r.refundsMinor}>{money(r.refundsMinor)}</Num> },
                  { key: "shipping", header: t("columns.shipping"), align: "right", priority: 2, cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey, kind: "sale" })} value={r.shippingMinor}>{money(r.shippingMinor)}</Num> },
                  { key: "tax", header: t("columns.tax"), align: "right", cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey })} value={r.taxMinor}>{money(r.taxMinor)}</Num> },
                  { key: "total", header: t("columns.total"), align: "right", className: "font-medium", cell: (r) => <Num href={dayHref(tenant, day, { rate: r.rateKey })} value={r.totalMinor}>{money(r.totalMinor)}</Num> },
                ]}
                footer={{ rate: t("totals"), gross: money(d.grossSalesMinor), discounts: money(d.discountsMinor), refunds: money(d.refundsMinor), shipping: money(d.shippingMinor), tax: money(d.taxMinor), total: money(d.totalMinor) }}
              />
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t("fees_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="day-fees">
            {d.fees.map((f) => (
              <p key={f.method} className="flex items-center justify-between gap-2"><span>{tp(f.method)} <span className="text-xs text-muted-foreground">· {formatNumber(f.orders, ctx.locale)}{f.estimatedOrders ? ` · ${t("estimated_n", { n: f.estimatedOrders })}` : ""}</span></span><Num href={dayHref(tenant, day, { method: f.method })} value={f.feeMinor}>{money(f.feeMinor)}</Num></p>
            ))}
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t pt-2">
              <dt className="text-muted-foreground">{t("columns.total")}</dt><dd className="text-right tabular">{money(d.totalMinor)}</dd>
              <dt className="text-muted-foreground">{t("columns.fees")}</dt><dd className="text-right tabular">{money(-d.feesMinor)}</dd>
              <dt className="font-medium">{t("columns.net")}</dt><dd className="text-right font-medium tabular" data-testid="day-net">{money(d.netMinor)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{t("day.orders_title")}</CardTitle>
            <CardDescription>{t("day.count", { n: orders.length })}{filterLabel ? ` · ${filterLabel}` : ""}</CardDescription>
          </div>
          <nav className="flex gap-1 overflow-x-auto text-sm" aria-label={t("day.orders_title")} data-testid="day-filters">
            {[undefined, ...KINDS].map((k) => (
              <Link key={k ?? "all"} href={dayHref(tenant, day, { kind: k })} aria-current={!rateKey && !method && kind === k ? "page" : undefined} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:py-2", !rateKey && !method && kind === k ? "bg-primary text-primary-foreground" : "bg-card")}>{k ? t(`day.kinds.${k}`) : t("day.all")}</Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <EmptyState title={filtered ? t("day.empty_filtered") : t("day.empty")} className="border-0" />
          ) : (
            <DataList
              data-testid="day-orders"
              rows={orders}
              rowKey={(o) => o.orderId}
              rowProps={() => ({ "data-testid": "day-order" })}
              columns={[
                { key: "order", header: t("day.columns.order"), mobile: "title", cell: (o) => <Link href={`/t/${tenant}/orders/${o.orderId}`} className="font-medium text-primary hover:underline">{o.name}</Link> },
                { key: "kinds", header: t("day.columns.kinds"), mobile: "badge", cell: (o) => <span className="flex flex-wrap gap-1">{o.kinds.map((k) => <Badge key={k} variant={k === "refund" ? "warning" : k === "fee" ? "outline" : "muted"}>{t(`day.kinds.${k}`)}</Badge>)}</span> },
                { key: "placed", header: t("day.columns.placed"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: (o) => `${formatDateTime(o.placedAt, ctx.locale, ctx.tenant.timezone)} · ${ts.has(o.status) ? ts(o.status) : o.status} · ${tp(o.paymentMethod)}` },
                { key: "gross", header: t("columns.gross"), align: "right", priority: 2, cell: (o) => <span className="tabular">{money(o.grossSalesMinor)}</span> },
                { key: "refunds", header: t("columns.refunds"), align: "right", priority: 2, cell: (o) => <span className="tabular">{money(o.refundsMinor)}</span> },
                { key: "tax", header: t("columns.tax"), align: "right", cell: (o) => <span className="tabular">{money(o.taxMinor)}</span> },
                { key: "total", header: t("columns.total"), align: "right", cell: (o) => <span className={cn("tabular", o.totalMinor < 0 && "text-destructive")}>{money(o.totalMinor)}</span> },
                { key: "fee", header: t("columns.fees"), align: "right", cell: (o) => <span className="tabular">{money(o.feeMinor)}</span> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(DailySalesDayPage, "app/t/[tenant]/analytics/daily-sales/[day]/page.tsx");
