import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatMoney, formatNumber, formatRelative, parseNoteMarkdown, type MdInline, type Period } from "@hullwise/core";
import { canViewPage, isCustomMetricRef, type DashboardWidget, type TenantRole } from "@hullwise/config";
import { customMetricBases, type AlertsData, type BackorderSummary, type BreakdownData, type CustomMetricRow, type DashboardSummary, type KpiData, type MetricSeries, type MonthForecast, type QueueData, type TargetData, type TopListData, type WidgetResult, type WorkQueueData } from "@hullwise/services";
import { Card, CardContent, CardHeader, CardTitle, Stat, cn } from "@hullwise/ui";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { MetricChart, Sparkline } from "@/components/charts/metric-chart";
import { StatusBadge } from "@/components/status-badge";
import { formatMetric, metricHref, periodParams, trendOf } from "./format";

export interface WidgetViewEnv {
  base: string;
  locale: string;
  currency: string;
  timezone: string;
  role: TenantRole;
  customs: CustomMetricRow[];
}

type T = Awaited<ReturnType<typeof getTranslations>>;

function metricLabel(t: T, ref: string, customLabel: string | null): string {
  if (isCustomMetricRef(ref)) return customLabel ?? ref.slice(7);
  return t.has(`metrics.${ref}`) ? t(`metrics.${ref}`) : ref;
}

/** Card frame of the catalog widgets: title, optional link to the list behind it. */
function Frame({ title, href, linkLabel, children, testId, className }: { title: string; href?: string | null; linkLabel?: string; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <Card className={cn("flex h-full flex-col", className)} data-testid={testId}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="truncate text-base">{title}</CardTitle>
        {href && linkLabel && <Link href={href} className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline">{linkLabel}</Link>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

export async function WidgetError({ reason }: { reason: string }) {
  const t = await getTranslations("dashboards.widget");
  return (
    <Card className="flex h-full items-center justify-center border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="widget-error" data-reason={reason}>
      {reason === "failed" ? t("error") : reason === "forbidden" ? t("forbidden") : t("unavailable")}
    </Card>
  );
}

export function WidgetSkeleton() {
  return <div className="h-full min-h-28 animate-pulse rounded-lg border bg-muted/40" data-testid="widget-loading" />;
}

function bucketLabel(b: { from: Date; key: string }, granularity: string, locale: string, tz: string): string {
  if (granularity === "month") return formatDate(b.from, locale, tz, { month: "short", year: "2-digit" });
  if (granularity === "week") return b.key.replace(/^\d{4}-/, "");
  return formatDate(b.from, locale, tz, { day: "numeric", month: "short" });
}

function Inline({ parts }: { parts: MdInline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "strong" ? <strong key={i}>{p.v}</strong> : p.t === "em" ? <em key={i}>{p.v}</em> : p.t === "code" ? <code key={i} className="rounded bg-muted px-1 text-xs">{p.v}</code> : p.t === "link" ? <a key={i} href={p.href} className="text-primary underline-offset-4 hover:underline" rel="noopener noreferrer">{p.v}</a> : <span key={i}>{p.v}</span>,
      )}
    </>
  );
}

/** Renders one widget's data. Hullwise's template tiles keep the exact markup of the former home page. */
export async function WidgetView({ widget, result, period, env }: { widget: DashboardWidget; result: WidgetResult; period: Period; env: WidgetViewEnv }) {
  if (!result.ok) return <WidgetError reason={result.reason} />;
  const t = await getTranslations("dashboards");
  const td = await getTranslations("dashboard");
  const { base, locale, currency, timezone: tz } = env;
  const money = (m: number) => formatMoney(m, currency, locale);
  const fmt = (v: number | null, f: Parameters<typeof formatMetric>[1]) => formatMetric(v, f, currency, locale, t("widget.days_unit"));
  const s = widget.settings as Record<string, unknown> & { title?: string };
  const data = result.data;
  const open = t("widget.open_list");

  switch (widget.type) {
    case "kpi": {
      const d = data as KpiData;
      const v = d.value;
      const cm = isCustomMetricRef(v.ref) ? env.customs.find((c) => `custom:${c.key}` === v.ref) : null;
      const href = metricHref(base, v.ref, period, tz, { filters: v.filters, firstBase: cm ? (customMetricBases(cm)[0] ?? null) : null });
      const trend = trendOf(v.value, v.previous, v.higherIsBetter);
      return (
        <Link href={href} className="block h-full rounded-lg border bg-card p-(--density-stat) shadow-sm transition-colors hover:bg-muted/40" data-testid={`kpi-${v.ref}`}>
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.title || metricLabel(t, v.ref, v.label)}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular" data-testid="kpi-value">{fmt(v.value, v.format)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {trend && <span className={cn("font-medium tabular", trend.good === true ? "text-success" : trend.good === false ? "text-destructive" : "")}>{trend.value > 0 ? "+" : ""}{(trend.value * 100).toFixed(1)}%</span>}
            {v.kind === "snapshot" ? t("widget.now") : v.previous !== null ? `${t("widget.vs_previous")} · ${fmt(v.previous, v.format)}` : t(`periods.${widget.period ?? "follow"}`)}
            {v.filters && <span className="rounded bg-muted px-1">{t("widget.filtered")}</span>}
          </p>
          {d.spark && d.spark.some((x) => x !== null) && <div className="mt-2"><Sparkline values={d.spark} /></div>}
        </Link>
      );
    }
    case "timeseries": {
      const d = data as MetricSeries;
      const g = String(s.granularity ?? "day");
      const labels = d.buckets.map((b) => bucketLabel(b, g, locale, tz));
      const title = s.title || d.series.map((x) => metricLabel(t, x.ref, x.label)).join(" · ");
      return (
        <Frame title={title} href={`${base}/analytics?tab=pnl&${periodParams(period, tz)}&granularity=${g}`} linkLabel={open} testId="widget-timeseries">
          <MetricChart labels={labels} series={d.series.map((x) => ({ key: x.ref.replace(/[^a-z0-9_]/gi, "_"), label: metricLabel(t, x.ref, x.label), format: x.format, values: x.values }))} chart={s.chart === "bar" ? "bar" : "line"} locale={locale} currency={currency} height={widget.h >= 2 ? 240 : 140} />
        </Frame>
      );
    }
    case "breakdown": {
      const d = data as BreakdownData;
      const by = String(s.by);
      const label = (r: BreakdownData["rows"][number]) => r.label ?? (by === "channel" && t.has(`channels.${r.key}`) ? t(`channels.${r.key}`) : by === "payment_method" && t.has(`payment_methods.${r.key}`) ? t(`payment_methods.${r.key}`) : by === "platform" && t.has(`platforms.${r.key}`) ? t(`platforms.${r.key}`) : r.key === "unknown" ? t("widget.unknown") : r.key);
      return (
        <Frame title={s.title || t("widget.breakdown_title", { metric: metricLabel(t, String(s.metric), null), by: t(`breakdown_dims.${by}`) })} testId="widget-breakdown">
          {d.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("widget.empty")}</p> : (
            <ul className="space-y-1.5">
              {d.rows.map((r) => {
                const share = d.total > 0 && r.value !== null ? Math.max(0, r.value / d.total) : 0;
                const body = (
                  <>
                    <span className="flex items-center justify-between gap-2 text-sm"><span className="min-w-0 truncate">{label(r)}</span><span className="shrink-0 tabular font-medium">{fmt(r.value, d.format)}</span></span>
                    <span className="mt-0.5 block h-1.5 rounded-full bg-muted"><span className="block h-1.5 rounded-full bg-primary" style={{ width: `${(share * 100).toFixed(1)}%` }} /></span>
                  </>
                );
                return <li key={r.key}>{r.path ? <Link href={`${base}/${r.path}`} className="block rounded-md px-1 py-0.5 hover:bg-muted/50">{body}</Link> : <div className="px-1 py-0.5">{body}</div>}</li>;
              })}
            </ul>
          )}
        </Frame>
      );
    }
    case "top_list": {
      const d = data as TopListData;
      const entity = String(s.entity);
      return (
        <Frame title={s.title || t(`top_entities.${entity}`)} href={`${base}/${entity === "products" ? "products" : entity === "campaigns" ? "campaigns" : entity === "ads" ? "campaigns/recommendations" : entity === "keywords" ? "campaigns/keywords" : entity === "search_terms" ? "campaigns/keywords?tab=search_terms" : "customers"}`} linkLabel={open} testId="widget-top-list">
          {d.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("widget.empty")}</p> : (
            <ol className="space-y-1">
              {d.rows.map((r, i) => (
                <li key={r.id}>
                  <Link href={`${base}/${r.path}`} className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/50">
                    <span className="min-w-0 truncate"><span className="mr-2 text-xs text-muted-foreground tabular">{i + 1}</span>{r.label}</span>
                    <span className="shrink-0 text-right tabular"><span className="font-medium">{fmt(r.value, d.format)}</span>{r.secondary !== null && <span className="ml-2 text-xs text-muted-foreground">{t(`top_secondary.${entity}`, { v: fmt(r.secondary, d.secondaryFormat) })}</span>}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Frame>
      );
    }
    case "target": {
      const d = data as TargetData;
      const v = d.value;
      const ratio = d.target && v.value !== null ? v.value / d.target : null;
      const projRatio = d.target && d.projected !== null ? d.projected / d.target : null;
      const good = projRatio === null ? null : v.higherIsBetter ? projRatio >= 1 : projRatio <= 1;
      const cm = isCustomMetricRef(v.ref) ? env.customs.find((c) => `custom:${c.key}` === v.ref) : null;
      const mtd = { from: new Date(Date.UTC(Number(d.targetMonth.slice(0, 4)), Number(d.targetMonth.slice(5)) - 1, 1)), to: period.to };
      return (
        <Frame title={s.title || t("widget.target_title", { metric: metricLabel(t, v.ref, v.label) })} href={metricHref(base, v.ref, mtd, tz, { filters: v.filters, firstBase: cm ? (customMetricBases(cm)[0] ?? null) : null })} linkLabel={open} testId="widget-target">
          <p className="text-2xl font-semibold tabular">{fmt(v.value, v.format)}</p>
          {d.target === null ? <p className="mt-1 text-xs text-muted-foreground">{t("widget.no_target")}</p> : (
            <>
              <div className="mt-2 h-2 rounded-full bg-muted"><div className={cn("h-2 rounded-full", good === false ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, Math.max(0, (ratio ?? 0) * 100)).toFixed(1)}%` }} /></div>
              <p className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{t("widget.of_target", { target: fmt(d.target, v.format) })}</span><span className="tabular">{ratio !== null ? `${(ratio * 100).toFixed(0)}%` : "—"}</span></p>
              <p className={cn("mt-1 text-xs", good === false ? "text-warning" : good ? "text-success" : "text-muted-foreground")}>{t("widget.projected", { value: fmt(d.projected, v.format), elapsed: d.elapsedDays, days: d.daysInMonth })}</p>
            </>
          )}
        </Frame>
      );
    }
    case "alerts": {
      const d = data as AlertsData;
      return (
        <Frame title={t("widget_types.alerts.name")} href={`${base}/analytics/alerts`} linkLabel={open} testId="widget-alerts">
          {d.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("widget.no_alerts")}</p> : (
            <ul className="space-y-1.5 text-sm">
              {d.rows.map((r) => (
                <li key={r.id}><Link href={`${base}/analytics/alerts`} className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5 hover:bg-muted/50"><span className="min-w-0 truncate">{r.name}</span><span className="shrink-0 text-xs text-muted-foreground">{formatRelative(r.firedAt, locale)}</span></Link></li>
              ))}
            </ul>
          )}
        </Frame>
      );
    }
    case "note": {
      const tr = (s.translations ?? {}) as Record<string, string>;
      const blocks = parseNoteMarkdown(tr[locale] || tr[locale.slice(0, 2)] || String(s.markdown ?? ""));
      return (
        <Frame title={s.title || t("widget_types.note.name")} testId="widget-note">
          <div className="space-y-2 text-sm">
            {blocks.length === 0 && <p className="text-muted-foreground">{t("widget.empty_note")}</p>}
            {blocks.map((b, i) => (b.t === "h" ? (b.level === 2 ? <h3 key={i} className="font-semibold"><Inline parts={b.inl} /></h3> : <h4 key={i} className="font-medium"><Inline parts={b.inl} /></h4>) : b.t === "p" ? <p key={i}><Inline parts={b.inl} /></p> : b.t === "ul" ? <ul key={i} className="list-disc space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>)}</ul> : <ol key={i} className="list-decimal space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>)}</ol>))}
          </div>
        </Frame>
      );
    }
    case "queue_review":
    case "queue_late":
    case "queue_awaiting_stock":
    case "queue_exceptions":
    case "queue_integrations":
    case "cod_queue": {
      const d = data as QueueData;
      const alert = d.count > 0 && widget.type !== "queue_review";
      return (
        <Link href={`${base}/${d.path}`} className="flex h-full flex-col justify-between rounded-lg border bg-card p-(--density-stat) shadow-sm transition-colors hover:bg-muted/40" data-testid={`queue-${widget.type}`}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(`widget_types.${widget.type}.name`)}</p>
          <p className={cn("mt-1 text-2xl font-semibold tabular", alert && "text-destructive")} data-testid="queue-count">{formatNumber(d.count, locale)}</p>
          {d.parts && <p className="mt-1 text-xs text-muted-foreground">{Object.entries(d.parts).map(([k, n]) => t(`queue_parts.${k}`, { n })).join(" · ")}</p>}
        </Link>
      );
    }

    /* ---------- Hullwise's template tiles ---------- */
    case "today_kpis": {
      const summary = data as DashboardSummary;
      const pctChange = (cur: number, prev: number) => (prev ? { value: (cur - prev) / prev } : null);
      const todayIso = summary.windows.today.from.toISOString().slice(0, 10);
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={td("kpi.revenue")} value={money(summary.today.grossRevenueMinor)} trend={pctChange(summary.today.grossRevenueMinor, summary.yesterday.grossRevenueMinor)} hint={`${td("vs_yesterday")} · ${money(summary.yesterday.grossRevenueMinor)}`} href={`${base}/orders?from=${todayIso}`} />
          <Stat label={td("kpi.orders")} value={formatNumber(summary.today.sales, locale)} trend={pctChange(summary.today.sales, summary.yesterday.sales)} hint={`${summary.today.placed} ${td("kpi.placed")} · ${td("vs_last_week")} ${summary.lastWeek.sales}`} href={`${base}/orders?from=${todayIso}`} />
          <Stat label={td("kpi.aov")} value={summary.today.aovMinor ? money(summary.today.aovMinor) : "—"} hint={summary.yesterday.sales ? `${td("vs_yesterday")} · ${money(Math.round(summary.yesterday.grossRevenueMinor / summary.yesterday.sales))}` : undefined} href={`${base}/orders?from=${todayIso}`} />
          <Stat label={td("kpi.cancel_rate")} value={summary.today.placed ? `${(((summary.today.byStatus.cancelled ?? 0) / summary.today.placed) * 100).toFixed(1)}%` : "—"} href={`${base}/orders?status=cancelled&from=${todayIso}`} />
        </div>
      );
    }
    case "sales_30d": {
      const summary = data as DashboardSummary;
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base"><Link href={`${base}/orders?from=${summary.series30d[0]?.day ?? ""}`} className="hover:underline">{td("revenue_30d")}</Link></CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueChart data={summary.series30d} locale={locale} currency={currency} ordersLabel={td("kpi.orders").toLowerCase()} />
          </CardContent>
        </Card>
      );
    }
    case "month_forecast": {
      const forecast = data as MonthForecast;
      return (
        <Card data-testid="forecast-card">
          <CardHeader>
            <CardTitle className="text-base">{td("forecast.title", { month: forecast.month })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex items-center justify-between"><span>{td("forecast.revenue")}</span><span className="tabular font-medium">{money(forecast.revenue.projected)}</span></div>
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{td("forecast.band")}</span><span className="tabular">{money(forecast.revenue.low)} – {money(forecast.revenue.high)}</span></div>
            <div className="flex items-center justify-between"><span>{td("forecast.orders")}</span><span className="tabular font-medium">{formatNumber(forecast.orders.projected, locale)}</span></div>
            <div className="flex items-center justify-between"><span>{td("forecast.spend")}</span><span className="tabular font-medium">{money(forecast.spend.projected)}</span></div>
            <p className="pt-1 text-xs text-muted-foreground">{td("forecast.hint", { elapsed: forecast.elapsedDays, days: forecast.daysInMonth })} <Link href={`${base}/analytics`} className="underline-offset-4 hover:underline">{td("forecast.more")}</Link></p>
          </CardContent>
        </Card>
      );
    }
    case "work_queue": {
      const d = data as WorkQueueData;
      const items: { key: string; value: number; href: string }[] = [
        { key: "fresh", value: d.open.fresh, href: `${base}/orders?status=new` },
        { key: "pending_review", value: d.open.pendingReview, href: `${base}/orders?status=pending_review` },
        { key: "on_hold", value: d.open.onHold, href: `${base}/orders?status=on_hold` },
        { key: "late_to_ship", value: d.lateToShip, href: `${base}/fulfilment?view=late` },
        { key: "shipment_exceptions", value: d.open.shipmentExceptions, href: `${base}/fulfilment/exceptions` },
        { key: "stuck_shipments", value: d.open.stuckShipments, href: `${base}/shipments?view=stuck` },
        { key: "returns_requested", value: d.open.returnsRequested, href: `${base}/returns?status=requested` },
        { key: "critical_variants", value: d.open.criticalVariants, href: `${base}/inventory?risk=critical` },
        { key: "failed_webhooks", value: d.open.failedWebhooks, href: `${base}/integrations` },
        // variants without a cost make every margin optimistic: the catalog check sits with the other open items
        { key: "catalog_quality", value: d.catalogIssues, href: `${base}/products/quality${d.catalogMissingCost ? "?issue=missing_cost" : ""}` },
      ];
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td("work_queue")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {items.map((i) => (
              <Link key={i.key} href={i.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                <span>{td(`open.${i.key}`)}</span>
                <span className={`tabular font-medium ${i.value > 0 && (i.key === "shipment_exceptions" || i.key === "failed_webhooks" || i.key === "critical_variants" || i.key === "late_to_ship") ? "text-destructive" : i.value > 0 && i.key === "catalog_quality" ? "text-warning" : ""}`}>{i.value}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      );
    }
    case "stock_backorders": {
      const stock = data as BackorderSummary;
      const ts = await getTranslations("dashboard.stock_tile");
      return (
        <Card data-testid="stock-tile">
          <CardHeader>
            <CardTitle className="text-base">{ts("title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {canViewPage(env.role, "orders") ? (
              <Link href={`${base}/orders?stock=awaiting`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50" data-testid="stock-tile-holding">
                <span>{ts("holding", { units: stock.holdingUnits })}</span>
                <span className={`tabular font-medium ${stock.holdingOrders > 0 ? "text-warning" : ""}`}>{stock.holdingOrders}</span>
              </Link>
            ) : (
              <p className="flex items-center justify-between px-2">{ts("holding", { units: stock.holdingUnits })} <span className="tabular font-medium">{stock.holdingOrders}</span></p>
            )}
            <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">{ts("best_sellers_low")}</p>
            {stock.lowStockBestSellers.length === 0 && <p className="px-2 text-xs text-muted-foreground">{ts("none_low")}</p>}
            {stock.lowStockBestSellers.map((v) => {
              const body = (
                <>
                  <span className="min-w-0 truncate">{v.label}</span>
                  <span className="shrink-0 text-xs tabular text-muted-foreground">{ts("cell", { sold: v.unitsSold, available: v.available, incoming: v.incoming })}{v.backordered > 0 ? ` · ${ts("waiting", { n: v.backordered })}` : ""}</span>
                </>
              );
              return canViewPage(env.role, "products") ? (
                <Link key={v.variantId} href={`${base}/products/${v.productId}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50">{body}</Link>
              ) : (
                <div key={v.variantId} className="flex items-center justify-between gap-2 px-2 py-1">{body}</div>
              );
            })}
          </CardContent>
        </Card>
      );
    }
    case "today_by_status": {
      const summary = data as DashboardSummary;
      const todayIso = summary.windows.today.from.toISOString().slice(0, 10);
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td("today_by_status")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(summary.today.byStatus).map(([st, n]) => (
              <Link key={st} href={`${base}/orders?status=${st}&from=${todayIso}`} className="inline-flex items-center gap-1">
                <StatusBadge status={st} /> <span className="tabular text-sm">{n}</span>
              </Link>
            ))}
            {Object.keys(summary.today.byStatus).length === 0 && <span className="text-sm text-muted-foreground">—</span>}
          </CardContent>
        </Card>
      );
    }
  }
  return <WidgetError reason="unknown" />;
}
