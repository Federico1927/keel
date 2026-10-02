import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CheckCircle2, Download } from "lucide-react";
import { GRANULARITIES, SALE_STATUSES, UTM_DIMENSIONS, UTM_NONE, formatDate, formatMoney, formatNumber, formatPercent, isUtmDimension, nextUtmDimension, type BucketPnl, type Granularity, type PeriodBucket, type UtmDimension } from "@hullwise/core";
import { ORDER_PNL_SORTS, PRODUCT_PROFIT_SORTS, catalogQualityReport, orderPnlTable, productProfitTable, utmReport, type OrderPnlSort, type PnlReport, type ProductProfitSort } from "@hullwise/services";
import { PAYMENT_METHODS } from "@hullwise/core";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, Input, Pagination, Select, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { analyticsTenant, runAnalytics } from "@/server/analytics";
import { utmParam } from "@/server/queries/orders";
import { PnlChart, TrendChart } from "@/components/charts/pnl-chart";
import { ChartFullscreen } from "@/components/mobile/chart-fullscreen";
import { WideTable } from "@/components/mobile/wide-table";
import { LightBadge } from "../campaigns/badges";

type Sp = Record<string, string | undefined>;
type Query = (patch: Record<string, string | undefined>) => string;
const SALE = SALE_STATUSES.join(",");
const PRODUCT_ACTIONS = ["pause_ads", "reorder", "last_units", "clear_excess", "scale_ads", "ok", "no_data"] as const;
export const day = (d: Date) => d.toISOString().slice(0, 10);
const lastDay = (to: Date) => day(new Date(to.getTime() - 1));
const pageOf = (v: string | undefined) => Math.max(1, Number(v ?? 1) || 1);

/** Readable bucket label in the user's locale. */
export function bucketLabel(b: PeriodBucket, g: Granularity, locale: string): string {
  if (g === "day") return formatDate(b.start, locale, "UTC", { day: "numeric", month: "short" });
  if (g === "week") return `${b.key.slice(5)} · ${formatDate(b.start, locale, "UTC", { day: "numeric", month: "short" })}`;
  if (g === "month") return formatDate(b.start, locale, "UTC", { month: "short", year: "numeric" });
  if (g === "quarter") return `${b.key.slice(5)} ${b.key.slice(0, 4)}`;
  return b.key;
}

/** Hidden inputs that keep the period and tab when a GET filter form is submitted. */
function Keep({ params }: { params: Record<string, string | undefined> }) {
  return (
    <>
      {Object.entries(params).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
    </>
  );
}

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline" data-testid="export-csv">
      <Download className="h-4 w-4" /> {label}
    </a>
  );
}

/* ---------- P/L by period: granularity switch, chart, table ---------- */

export async function PnlPeriods({ ctx, tenant, pnl, buckets, granularity, query, sp }: { ctx: TenantContext; tenant: string; pnl: PnlReport; buckets: BucketPnl[]; granularity: Granularity; query: Query; sp: Sp }) {
  const t = await getTranslations("analytics_depth");
  const tp = await getTranslations("analytics.pnl");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const orders = (b: PeriodBucket) => `/t/${tenant}/orders?from=${day(b.from)}&to=${lastDay(b.to)}&status=${SALE}`;
  const size = 31;
  const pages = Math.max(1, Math.ceil(buckets.length / size));
  const page = Math.min(pageOf(sp.bpage), pages);
  const shown = [...buckets].reverse().slice((page - 1) * size, page * size);
  const series = (["cogs", "shipping", "fees", "returns", "ads", "fixed"] as const).map((k) => ({ key: k, label: t(`periods.series.${k}`) }));
  const chart = buckets.map((b) => ({ label: bucketLabel(b.bucket, granularity, ctx.locale), partial: b.bucket.partial, profitMinor: b.operatingProfitMinor, costs: { cogs: b.cogsMinor, shipping: b.shippingCostMinor, fees: b.paymentFeeMinor, returns: b.returnCostsMinor, ads: b.adSpendMinor, fixed: b.fixedCostsMinor } }));
  return (
    <div className="border-t" data-testid="pnl-periods">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <p className="flex items-center gap-3 text-sm font-medium">{t("periods.title")} <ExportLink href={query({ tab: undefined, gran: granularity }).replace("/analytics?", "/analytics/export/pnl?")} label={t("export")} /></p>
        <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-xs">
          {GRANULARITIES.map((g) => (
            <Link key={g} href={query({ tab: "pnl", gran: g })} className={cn("rounded-sm px-2 py-1", g === granularity ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`gran-${g}`}>
              {t(`granularity.${g}`)}
            </Link>
          ))}
        </div>
      </div>
      <div className="px-2 pt-3 sm:px-4">
        <ChartFullscreen title={t("periods.title")}><PnlChart data={chart} series={series} profitLabel={tp("operating")} partialLabel={t("periods.partial")} locale={ctx.locale} currency={ctx.tenant.currency} /></ChartFullscreen>
        <p className="pt-1 text-xs text-muted-foreground">{t("periods.chart_hint")}</p>
      </div>
      <WideTable label={t("periods.title")} stickyFirst data-testid="pnl-periods-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t(`granularity.${granularity}`)}</TableHead>
              <TableHead className="text-right">{tp("orders")}</TableHead>
              <TableHead className="text-right">{tp("net")}</TableHead>
              <TableHead className="text-right">{tp("cogs")}</TableHead>
              <TableHead className="text-right">{tp("contribution")}</TableHead>
              <TableHead className="text-right">{tp("ads")}</TableHead>
              <TableHead className="text-right">{tp("fixed")}</TableHead>
              <TableHead className="text-right">{tp("operating")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((b) => (
              <TableRow key={b.bucket.key} data-testid="pnl-bucket">
                <TableCell className="whitespace-nowrap!">
                  <Link href={query({ tab: "orders_pnl", preset: undefined, from: day(b.bucket.from), to: lastDay(b.bucket.to) })} className="hover:underline">{bucketLabel(b.bucket, granularity, ctx.locale)}</Link>
                  {b.bucket.partial && <Badge variant="outline" className="ml-1 text-[10px]" title={t("periods.partial_hint")}>{t("periods.partial")}</Badge>}
                </TableCell>
                <TableCell className="text-right tabular"><Link href={orders(b.bucket)} className="hover:underline">{formatNumber(b.orders, ctx.locale)}</Link></TableCell>
                <TableCell className="text-right tabular">{money(b.netRevenueMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(b.cogsMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(b.contributionMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(b.adSpendMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(b.fixedCostsMinor)}</TableCell>
                <TableCell className={cn("text-right tabular font-medium", b.operatingProfitMinor < 0 && "text-destructive")}>{money(b.operatingProfitMinor)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium" data-testid="pnl-bucket-total">
              <TableCell>{t("total")}</TableCell>
              <TableCell className="text-right tabular">{formatNumber(pnl.orders, ctx.locale)}</TableCell>
              <TableCell className="text-right tabular">{money(pnl.netRevenueMinor)}</TableCell>
              <TableCell className="text-right tabular">{money(pnl.cogsMinor)}</TableCell>
              <TableCell className="text-right tabular">{money(pnl.contributionMinor)}</TableCell>
              <TableCell className="text-right tabular">{money(pnl.adSpendMinor)}</TableCell>
              <TableCell className="text-right tabular">{money(pnl.fixedCostsMinor)}</TableCell>
              <TableCell className={cn("text-right tabular", pnl.operatingProfitMinor < 0 && "text-destructive")}>{money(pnl.operatingProfitMinor)}</TableCell>
            </TableRow>
          </TableBody>
      </WideTable>
      {pages > 1 && <Pagination className="p-3" page={page} pageSize={size} total={buckets.length} hrefFor={(p) => query({ tab: "pnl", gran: granularity, bpage: String(p) })} summary={t("periods.pages", { n: buckets.length })} />}
    </div>
  );
}

/* ---------- data quality widget ---------- */

export async function DataQualityCard({ ctx, tenant, pnl, fromIso, toIso }: { ctx: TenantContext; tenant: string; pnl: PnlReport; fromIso: string; toIso: string }) {
  const t = await getTranslations("analytics_depth.quality");
  const catalog = await runAnalytics(ctx, (s) => catalogQualityReport(s));
  const share = pnl.netRevenueMinor ? pnl.cogsIncompleteRevenueMinor / pnl.netRevenueMinor : null;
  const ok = pnl.cogsIncompleteOrders === 0 && catalog.counts.missing_cost === 0;
  return (
    <Card data-testid="data-quality">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">{ok && <CheckCircle2 className="h-4 w-4 text-success" />}{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Link href={`/t/${tenant}/orders?from=${fromIso}&to=${toIso}&status=${SALE}&missingCost=1`} className="block rounded-lg border p-3 hover:bg-muted/40" data-testid="quality-incomplete-orders">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("incomplete_orders")}</p>
          <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular", pnl.cogsIncompleteOrders > 0 && "text-warning")}>{formatNumber(pnl.cogsIncompleteOrders, ctx.locale)}</p>
          <p className="text-xs text-muted-foreground">{t("incomplete_share", { share: formatPercent(share, ctx.locale) })}</p>
        </Link>
        <Link href={`/t/${tenant}/products/quality?issue=missing_cost`} className="block rounded-lg border p-3 hover:bg-muted/40" data-testid="quality-missing-cost">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("variants_missing_cost")}</p>
          <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular", catalog.counts.missing_cost > 0 && "text-warning")}>{formatNumber(catalog.counts.missing_cost, ctx.locale)}</p>
          <p className="text-xs text-muted-foreground">{t("fix_link")}</p>
        </Link>
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("cost_known")}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular">{formatPercent(pnl.costCoverage.totalMinor ? pnl.costCoverage.coveredShare : null, ctx.locale)}</p>
          <p className="text-xs text-muted-foreground">{t("cost_known_hint")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------- per-order P/L ---------- */

export async function OrderPnlTab({ ctx, tenant, period, query, sp, keep }: { ctx: TenantContext; tenant: string; period: { from: Date; to: Date }; query: Query; sp: Sp; keep: Record<string, string | undefined> }) {
  const t = await getTranslations("analytics_depth");
  const tp = await getTranslations("analytics.pnl");
  const tpm = await getTranslations("payment_methods");
  const tst = await getTranslations("order_status");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const sort: OrderPnlSort = (ORDER_PNL_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as OrderPnlSort) : "placed_desc";
  const filters = { q: sp.q || undefined, payment: (PAYMENT_METHODS as readonly string[]).includes(sp.payment ?? "") ? sp.payment : undefined, channel: sp.channel || undefined, missingCost: sp.missingCost === "1", loss: sp.loss === "1", sort };
  const data = await runAnalytics(ctx, (s) => orderPnlTable(s, analyticsTenant(ctx), period, filters, pageOf(sp.page), 50));
  const filtered = Boolean(filters.q || filters.payment || filters.channel || filters.missingCost || filters.loss);
  const fromIso = day(period.from);
  const toIso = lastDay(period.to);
  const listParams = new URLSearchParams({ from: fromIso, to: toIso, status: SALE, ...(filters.payment ? { payment: filters.payment } : {}), ...(filters.channel ? { attrChannel: filters.channel } : {}), ...(filters.missingCost ? { missingCost: "1" } : {}), ...(filters.q ? { q: filters.q } : {}) });
  const ordersHref = `/t/${tenant}/orders?${listParams}`;
  const exportParams = new URLSearchParams(Object.entries({ ...keep, ...filters, missingCost: filters.missingCost ? "1" : undefined, loss: filters.loss ? "1" : undefined }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const tot = data.totals;
  const r = data.reconciliation;
  const recon: { key: string; value: number; bold?: boolean; hint?: string }[] = [
    { key: "orders_contribution", value: r.ordersContributionMinor },
    { key: "shipping_adjustment", value: 0 - r.shippingAdjustmentMinor || 0, hint: t("orders_pnl.shipping_adjustment_hint") },
    { key: "return_timing", value: 0 - r.returnTimingMinor || 0, hint: t("orders_pnl.return_timing_hint") },
    { key: "contribution", value: r.contributionMinor, bold: true },
    { key: "ads", value: 0 - r.adSpendMinor || 0 },
    { key: "fixed", value: 0 - r.fixedCostsMinor || 0 },
    { key: "operating", value: r.operatingProfitMinor, bold: true },
  ];
  const matches = r.contributionMinor === data.pnl.contributionMinor && r.operatingProfitMinor === data.pnl.operatingProfitMinor && data.periodTotals.netRevenueMinor === data.pnl.netRevenueMinor;
  return (
    <div className="space-y-6">
      <Card className="min-w-0" data-testid="orders-pnl">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{t("orders_pnl.title")}</CardTitle>
            <CardDescription>{t("orders_pnl.description", { out: data.outOfScope })}</CardDescription>
          </div>
          <ExportLink href={`/t/${tenant}/analytics/export/orders?${exportParams}`} label={t("export")} />
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          <form method="get" className="grid gap-2 px-4 sm:grid-cols-2 lg:grid-cols-6" data-testid="orders-pnl-filters">
            <Keep params={keep} />
            <Input name="q" defaultValue={filters.q ?? ""} placeholder={t("orders_pnl.search")} aria-label={t("orders_pnl.search")} size="sm" />
            <Select name="payment" defaultValue={filters.payment ?? ""} aria-label={t("orders_pnl.payment")} size="sm">
              <option value="">{t("orders_pnl.payment")}</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{tpm(m)}</option>)}
            </Select>
            <Select name="channel" defaultValue={filters.channel ?? ""} aria-label={t("orders_pnl.channel")} size="sm">
              <option value="">{t("orders_pnl.channel")}</option>
              {data.channels.map((c) => <option key={c} value={c}>{t.has(`channels.${c}`) ? t(`channels.${c}`) : c}</option>)}
            </Select>
            <Select name="sort" defaultValue={sort} aria-label={t("sort")} size="sm">
              {ORDER_PNL_SORTS.map((s) => <option key={s} value={s}>{t(`orders_pnl.sort.${s}`)}</option>)}
            </Select>
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-1"><input type="checkbox" name="missingCost" value="1" defaultChecked={filters.missingCost} /> {t("orders_pnl.missing_cost")}</label>
              <label className="flex items-center gap-1"><input type="checkbox" name="loss" value="1" defaultChecked={filters.loss} /> {t("orders_pnl.loss")}</label>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="secondary">{t("apply")}</Button>
              {filtered && <Link href={query({ tab: "orders_pnl" })} className="text-sm text-muted-foreground hover:underline">{t("clear")}</Link>}
            </div>
          </form>
          {data.rows.length === 0 ? (
            <EmptyState title={t("orders_pnl.empty")} className="m-4" />
          ) : (
            <DataList
              rows={data.rows}
              rowKey={(o) => o.orderId}
              rowProps={() => ({ "data-testid": "order-pnl-row" })}
              columns={[
                { key: "order", header: t("orders_pnl.order"), mobile: "title", cell: (o) => <><Link href={`/t/${tenant}/orders/${o.orderId}`} className="font-medium text-primary hover:underline">{o.name}</Link><p className="text-xs font-normal text-muted-foreground">{formatDate(o.placedAt, ctx.locale, ctx.tenant.timezone)} · {tst(o.status)}</p></> },
                { key: "payment", header: t("orders_pnl.payment"), cell: (o) => tpm(o.paymentMethod) },
                { key: "channel", header: t("orders_pnl.channel"), priority: 2, cell: (o) => (t.has(`channels.${o.channel}`) ? t(`channels.${o.channel}`) : o.channel) },
                { key: "net", header: tp("net"), align: "right", className: "tabular whitespace-nowrap", cell: (o) => money(o.netRevenueMinor) },
                { key: "cogs", header: tp("cogs"), align: "right", className: "tabular whitespace-nowrap", cell: (o) => <>{money(o.cogsMinor)}{!o.cogsComplete && <Badge variant="warning" className="ml-1 text-[10px]">{t("orders_pnl.no_cost")}</Badge>}</> },
                { key: "shipping", header: tp("shipping"), align: "right", priority: 2, className: "tabular whitespace-nowrap", cell: (o) => money(o.shippingCostMinor) },
                { key: "fee", header: t("orders_pnl.fee_estimated"), align: "right", priority: 2, className: "tabular whitespace-nowrap", cell: (o) => money(o.paymentFeeMinor) },
                { key: "returns", header: tp("return_costs"), align: "right", priority: 3, className: "tabular whitespace-nowrap", cell: (o) => money(o.returnCostMinor) },
                { key: "contribution", header: tp("contribution"), mobile: "badge", align: "right", className: "tabular whitespace-nowrap font-medium", cell: (o) => <span className={cn(o.contributionMinor < 0 && "text-destructive")}>{money(o.contributionMinor)}</span> },
              ]}
              footer={{
                order: <Link href={ordersHref} className="hover:underline" data-testid="order-pnl-total">{t("orders_pnl.total", { n: formatNumber(tot.orders, ctx.locale) })}</Link>,
                contribution: <span className={cn(tot.contributionMinor < 0 && "text-destructive")}>{money(tot.contributionMinor)}</span>,
                net: money(tot.netRevenueMinor),
                cogs: money(tot.cogsMinor),
                shipping: money(tot.shippingCostMinor),
                fee: money(tot.paymentFeeMinor),
                returns: money(tot.returnCostMinor),
              }}
            />
          )}
          <Pagination className="p-3" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => query({ tab: "orders_pnl", ...filters, missingCost: filters.missingCost ? "1" : undefined, loss: filters.loss ? "1" : undefined, sort: sort === "placed_desc" ? undefined : sort, page: String(p) })} summary={t("orders_pnl.summary", { n: formatNumber(data.total, ctx.locale) })} />
        </CardContent>
      </Card>
      <Card data-testid="orders-pnl-reconciliation">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">{matches && <CheckCircle2 className="h-4 w-4 text-success" />}{t("orders_pnl.reconciliation")}</CardTitle>
          <CardDescription>{filtered ? t("orders_pnl.reconciliation_filtered") : t("orders_pnl.reconciliation_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {recon.map((l) => (
            <div key={l.key} className={cn("flex items-center justify-between gap-2", l.bold && "border-t pt-1 font-medium")} title={l.hint} data-testid={`recon-${l.key}`}>
              <span>{t(`orders_pnl.recon.${l.key}`)}</span>
              <span className={cn("tabular", l.value < 0 && l.bold && "text-destructive")}>{money(l.value)}</span>
            </div>
          ))}
          <p className="pt-2 text-xs text-muted-foreground">{matches ? t("orders_pnl.matches") : t("orders_pnl.mismatch")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------- products with ads and stock ---------- */

export async function ProductsTab({ ctx, tenant, period, query, sp, keep }: { ctx: TenantContext; tenant: string; period: { from: Date; to: Date }; query: Query; sp: Sp; keep: Record<string, string | undefined> }) {
  const t = await getTranslations("analytics_depth");
  const tp = await getTranslations("analytics.products");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const sort: ProductProfitSort = (PRODUCT_PROFIT_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as ProductProfitSort) : "net_desc";
  const action = (PRODUCT_ACTIONS as readonly string[]).includes(sp.action ?? "") ? (sp.action as (typeof PRODUCT_ACTIONS)[number]) : undefined;
  const data = await runAnalytics(ctx, (s) => productProfitTable(s, analyticsTenant(ctx), period, { q: sp.q || undefined, action, sort, page: pageOf(sp.page), pageSize: 25 }));
  const fromIso = day(period.from);
  const toIso = lastDay(period.to);
  const ordersOf = (productId: string) => `/t/${tenant}/orders?from=${fromIso}&to=${toIso}&status=${SALE}&product=${productId}`;
  const ratio = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}×`);
  const exportParams = new URLSearchParams(Object.entries({ ...keep, q: sp.q, action, sort }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const actionVariant = (a: string) => (a === "pause_ads" ? "destructive" : a === "reorder" || a === "last_units" ? "warning" : a === "scale_ads" ? "success" : a === "clear_excess" ? "info" : "muted");
  return (
    <Card className="min-w-0" data-testid="product-profit">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{tp("title")}</CardTitle>
          <CardDescription>{t("products.description")}</CardDescription>
        </div>
        <ExportLink href={`/t/${tenant}/analytics/export/products?${exportParams}`} label={t("export")} />
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        <form method="get" className="grid gap-2 px-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="products-filters">
          <Keep params={keep} />
          <Input name="q" defaultValue={sp.q ?? ""} placeholder={t("products.search")} aria-label={t("products.search")} size="sm" className="lg:col-span-2" />
          <Select name="action" defaultValue={action ?? ""} aria-label={t("products.action")} size="sm">
            <option value="">{t("products.all_actions")}</option>
            {PRODUCT_ACTIONS.map((a) => <option key={a} value={a}>{t(`products.actions.${a}`)}</option>)}
          </Select>
          <Select name="sort" defaultValue={sort} aria-label={t("sort")} size="sm">
            {PRODUCT_PROFIT_SORTS.map((s) => <option key={s} value={s}>{t(`products.sort.${s}`)}</option>)}
          </Select>
          <Button type="submit" size="sm" variant="secondary">{t("apply")}</Button>
        </form>
        {data.rows.length === 0 ? (
          <EmptyState title={tp("empty")} className="m-4" />
        ) : (
          <WideTable label={tp("title")} stickyFirst data-testid="product-profit-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{tp("product")}</TableHead>
                  <TableHead className="text-right">{tp("units")}</TableHead>
                  <TableHead className="text-right">{t("products.net")}</TableHead>
                  <TableHead className="text-right">{tp("cogs")}</TableHead>
                  <TableHead className="text-right">{t("products.ad_spend")}</TableHead>
                  <TableHead className="text-right">{t("products.profit")}</TableHead>
                  <TableHead className="text-right">ROAS · ROI</TableHead>
                  <TableHead>{t("products.light")}</TableHead>
                  <TableHead className="text-right">{t("products.stock")}</TableHead>
                  <TableHead className="text-right">{t("products.cover")}</TableHead>
                  <TableHead>{t("products.action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.productId} data-testid="product-profit-row">
                    <TableCell className="min-w-36"><Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.title}</Link>{r.unitsWithoutCost > 0 && <Badge variant="warning" className="ml-1 text-[10px]">{t("orders_pnl.no_cost")}</Badge>}</TableCell>
                    <TableCell className="text-right tabular"><Link href={ordersOf(r.productId)} className="hover:underline">{formatNumber(r.units, ctx.locale)}</Link></TableCell>
                    <TableCell className="text-right tabular"><Link href={ordersOf(r.productId)} className="hover:underline">{money(r.netRevenueMinor)}</Link></TableCell>
                    <TableCell className="text-right tabular">{money(r.cogsMinor)}</TableCell>
                    <TableCell className="text-right tabular">{r.adSpendMinor ? <Link href={`/t/${tenant}/campaigns?from=${fromIso}&to=${toIso}`} className="hover:underline" title={t("products.campaigns", { n: r.campaigns })}>{money(r.adSpendMinor)}</Link> : "—"}</TableCell>
                    <TableCell className={cn("text-right tabular font-medium", r.profitMinor < 0 && "text-destructive")}>{money(r.profitMinor)}</TableCell>
                    <TableCell className="text-right tabular">{ratio(r.roas)} · {r.roi === null ? "—" : formatPercent(r.roi, ctx.locale, 0)}</TableCell>
                    <TableCell>{r.light === "none" ? <span className="text-muted-foreground">—</span> : <LightBadge light={r.light} />}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.available, ctx.locale)}{r.incoming > 0 && <span className="text-xs text-muted-foreground"> +{formatNumber(r.incoming, ctx.locale)}</span>}</TableCell>
                    <TableCell className="text-right tabular">{r.coverDays === null ? "—" : t("products.days", { n: Math.round(r.coverDays) })}</TableCell>
                    <TableCell className="whitespace-nowrap"><Badge variant={actionVariant(r.action)}>{t(`products.actions.${r.action}`)}</Badge>{r.reorderUnits > 0 && <span className="ml-1 text-xs text-muted-foreground tabular">{t("products.reorder_units", { n: r.reorderUnits })}</span>}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40" data-testid="unattributed-row">
                  <TableCell colSpan={4} className="text-sm whitespace-normal!">{t("products.unattributed", { n: data.unlinkedCampaigns })} <Link href={`/t/${tenant}/campaigns`} className="text-xs underline-offset-4 hover:underline">{t("products.link_campaigns")}</Link></TableCell>
                  <TableCell className="text-right tabular">{money(data.unattributedMinor)}</TableCell>
                  <TableCell className="text-right tabular text-destructive">{money(0 - data.unattributedMinor || 0)}</TableCell>
                  <TableCell colSpan={5} />
                </TableRow>
                <TableRow className="bg-muted/40 font-medium" data-testid="product-profit-total">
                  <TableCell>{t("total")}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(data.totals.units, ctx.locale)}</TableCell>
                  <TableCell className="text-right tabular">{money(data.totals.netRevenueMinor)}</TableCell>
                  <TableCell className="text-right tabular">{money(data.totals.cogsMinor)}</TableCell>
                  <TableCell className="text-right tabular" data-testid="product-ad-spend-total">{money(data.totals.adSpendMinor + data.unattributedMinor)}</TableCell>
                  <TableCell className={cn("text-right tabular", data.totals.profitMinor - data.unattributedMinor < 0 && "text-destructive")}>{money(data.totals.profitMinor - data.unattributedMinor)}</TableCell>
                  <TableCell colSpan={5} className="text-xs font-normal text-muted-foreground">{t("products.spend_matches", { spend: money(data.adSpendMinor) })}</TableCell>
                </TableRow>
              </TableBody>
          </WideTable>
        )}
        <Pagination className="p-3" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => query({ tab: "products", q: sp.q, action, sort: sort === "net_desc" ? undefined : sort, page: String(p) })} summary={t("products.summary", { n: data.total })} />
      </CardContent>
    </Card>
  );
}

/* ---------- UTM drill-down and channel trend ---------- */

export async function UtmTab({ ctx, tenant, period, granularity, query, sp, keep }: { ctx: TenantContext; tenant: string; period: { from: Date; to: Date }; granularity: Granularity; query: Query; sp: Sp; keep: Record<string, string | undefined> }) {
  const t = await getTranslations("analytics_depth");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const dim: UtmDimension = isUtmDimension(sp.dim) ? sp.dim : "source";
  // the parents of the open dimension, fixed by earlier clicks
  const filter: Partial<Record<UtmDimension, string>> = {};
  for (const d of UTM_DIMENSIONS) if (d !== dim && sp[utmParam(d)]) filter[d] = sp[utmParam(d)];
  const data = await runAnalytics(ctx, (s) => utmReport(s, analyticsTenant(ctx), period, dim, filter, granularity));
  const filterParams = Object.fromEntries(Object.entries(filter).map(([d, v]) => [utmParam(d as UtmDimension), v]));
  const fromIso = day(period.from);
  const toIso = lastDay(period.to);
  const ordersOf = (extra: Record<string, string>) => `/t/${tenant}/orders?${new URLSearchParams({ from: fromIso, to: toIso, status: SALE, ...filterParams, ...extra })}`;
  const next = nextUtmDimension(dim);
  const crumbs = UTM_DIMENSIONS.filter((d) => filter[d]);
  const per = 25;
  const pages = Math.max(1, Math.ceil(data.groups.length / per));
  const page = Math.min(pageOf(sp.page), pages);
  const exportParams = new URLSearchParams(Object.entries<string | undefined>({ ...keep, dim, ...filterParams }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const label = (v: string) => (v === UTM_NONE ? t("utm.none") : v);
  const channelLabels = Object.fromEntries(data.trend.keys.map((k) => [k, t.has(`channels.${k}`) ? t(`channels.${k}`) : k]));
  return (
    <div className="space-y-6">
      <Card className="min-w-0" data-testid="utm-card">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{t("utm.title")}</CardTitle>
            <CardDescription>{t("utm.description", { n: data.unattributedOrders })}</CardDescription>
          </div>
          <ExportLink href={`/t/${tenant}/analytics/export/utm?${exportParams}`} label={t("export")} />
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          <div className="flex flex-wrap items-center gap-1 px-4 text-sm" data-testid="utm-dims">
            {UTM_DIMENSIONS.map((d) => (
              <Link key={d} href={query({ tab: "utm", dim: d, ...Object.fromEntries(Object.entries(filterParams).filter(([k]) => k !== utmParam(d))) })} className={cn("rounded-full border px-3 py-1 text-xs", d === dim ? "bg-primary text-primary-foreground" : "bg-card")} data-testid={`utm-dim-${d}`}>
                {t(`utm.dims.${d}`)}
              </Link>
            ))}
          </div>
          {crumbs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 text-xs" data-testid="utm-crumbs">
              {crumbs.map((d) => (
                <Link key={d} href={query({ tab: "utm", dim, ...Object.fromEntries(Object.entries(filterParams).filter(([k]) => k !== utmParam(d))) })} className="rounded-full border border-info/60 bg-info/10 px-2 py-0.5 hover:line-through">
                  {t(`utm.dims.${d}`)}: {label(filter[d]!)} ×
                </Link>
              ))}
              <Link href={query({ tab: "utm" })} className="text-muted-foreground hover:underline">{t("clear")}</Link>
            </div>
          )}
          {data.groups.length === 0 ? (
            <EmptyState title={t("utm.empty")} className="m-4" />
          ) : (
            <WideTable label={t("utm.title")} stickyFirst data-testid="utm-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(`utm.dims.${dim}`)}</TableHead>
                    <TableHead className="text-right">{t("utm.orders")}</TableHead>
                    <TableHead className="text-right">{t("utm.revenue")}</TableHead>
                    <TableHead className="text-right">{t("utm.net")}</TableHead>
                    <TableHead className="text-right">{t("utm.aov")}</TableHead>
                    <TableHead className="text-right">{t("utm.share")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groups.slice((page - 1) * per, page * per).map((g) => {
                    const orders = ordersOf({ [utmParam(dim)]: g.value });
                    return (
                      <TableRow key={g.value} data-testid="utm-row">
                        <TableCell>{next ? <Link href={query({ tab: "utm", dim: next, ...filterParams, [utmParam(dim)]: g.value })} className="font-medium text-primary hover:underline">{label(g.value)}</Link> : <span className="font-medium">{label(g.value)}</span>}</TableCell>
                        <TableCell className="text-right tabular"><Link href={orders} className="hover:underline">{formatNumber(g.orders, ctx.locale)}</Link></TableCell>
                        <TableCell className="text-right tabular"><Link href={orders} className="hover:underline">{money(g.grossRevenueMinor)}</Link></TableCell>
                        <TableCell className="text-right tabular">{money(g.netRevenueMinor)}</TableCell>
                        <TableCell className="text-right tabular">{g.aovMinor === null ? "—" : money(g.aovMinor)}</TableCell>
                        <TableCell className="text-right tabular">{formatPercent(g.revenueShare, ctx.locale)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/40 font-medium">
                    <TableCell>{t("total")}</TableCell>
                    <TableCell className="text-right tabular"><Link href={ordersOf({})} className="hover:underline">{formatNumber(data.orders, ctx.locale)}</Link></TableCell>
                    <TableCell className="text-right tabular">{money(data.grossRevenueMinor)}</TableCell>
                    <TableCell className="text-right tabular">{money(data.netRevenueMinor)}</TableCell>
                    <TableCell className="text-right tabular">{data.orders ? money(Math.round(data.grossRevenueMinor / data.orders)) : "—"}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
            </WideTable>
          )}
          {pages > 1 && <Pagination className="p-3" page={page} pageSize={per} total={data.groups.length} hrefFor={(p) => query({ tab: "utm", dim, ...filterParams, page: String(p) })} summary={t("utm.summary", { n: data.groups.length })} />}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{t("utm.trend_title")}</CardTitle>
            <CardDescription>{t("utm.trend_description")}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-xs">
            {GRANULARITIES.map((g) => (
              <Link key={g} href={query({ tab: "utm", dim, ...filterParams, gran: g })} className={cn("rounded-sm px-2 py-1", g === granularity ? "bg-card shadow-sm" : "text-muted-foreground")}>
                {t(`granularity.${g}`)}
              </Link>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <ChartFullscreen title={t("utm.trend_title")}><TrendChart data={data.trend.points.map((p) => ({ label: bucketLabel(p.bucket, granularity, ctx.locale), values: Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, v.netRevenueMinor])) }))} keys={data.trend.keys} labels={channelLabels} locale={ctx.locale} currency={ctx.tenant.currency} /></ChartFullscreen>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {data.trend.keys.filter((k) => k !== "other").map((k) => (
              <Link key={k} href={`/t/${tenant}/orders?${new URLSearchParams({ from: fromIso, to: toIso, status: SALE, attrChannel: k })}`} className="rounded-full border px-2 py-0.5 hover:bg-muted/40" data-testid="channel-link">
                {channelLabels[k]}: {money(data.trend.points.reduce((s, p) => s + (p.values[k]?.netRevenueMinor ?? 0), 0))}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
