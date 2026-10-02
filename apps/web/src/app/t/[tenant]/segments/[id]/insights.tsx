import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent } from "@keel/core";
import type { SegmentInsights } from "@keel/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Stat } from "@keel/ui";

/** What the segment's members buy (core CRM): spend, top products, categories, option values, sales channels, reachability. */
export async function SegmentInsightsCard({ tenant, insights: x, currency, locale }: { tenant: string; insights: SegmentInsights; currency: string; locale: string }) {
  const t = await getTranslations("segments.insights");
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, currency, locale));
  const share = (n: number, of: number) => (of ? formatPercent(n / of, locale, 0) : "—");
  const totalOrders = x.channels.reduce((a, c) => a + c.orders, 0);
  const list = (title: string, rows: { key: string; label: ReactNode; value: string; hint?: string }[], testId: string) => (
    <div data-testid={testId}>
      <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
        <ul className="divide-y text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-2 py-1"><span className="min-w-0 truncate">{r.label}</span><span className="shrink-0 tabular text-muted-foreground" title={r.hint}>{r.value}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <Card className="mt-6" data-testid="segment-insights">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t("avg_spent")} value={money(x.avgSpentMinor)} hint={t("buyers", { n: formatNumber(x.buyers, locale), of: formatNumber(x.members, locale) })} />
          <Stat label={t("aov")} value={money(x.aovMinor)} />
          <Stat label={t("avg_orders")} value={x.avgOrders === null ? "—" : formatNumber(x.avgOrders, locale, { maximumFractionDigits: 1 })} />
          <Stat label={t("reachable")} value={`${formatNumber(x.reachable.email, locale)} / ${formatNumber(x.reachable.phone, locale)}`} hint={t("reachable_hint")} />
        </div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {list(t("top_products"), x.topProducts.map((p) => ({ key: p.productId, label: <Link href={`/t/${tenant}/products/${p.productId}`} className="hover:underline">{p.title}</Link>, value: t("units", { n: formatNumber(p.units, locale) }), hint: t("customers_n", { n: formatNumber(p.customers, locale) }) })), "insights-products")}
          {list(t("top_categories"), x.topCategories.map((c) => ({ key: c.category, label: c.category, value: t("units", { n: formatNumber(c.units, locale) }), hint: money(c.revenueMinor) })), "insights-categories")}
          {list(t("top_options"), x.topOptionValues.map((o) => ({ key: `${o.option}:${o.value}`, label: <><span className="text-muted-foreground">{o.option}:</span> {o.value}</>, value: t("units", { n: formatNumber(o.units, locale) }), hint: t("customers_n", { n: formatNumber(o.customers, locale) }) })), "insights-options")}
          {list(t("channels_title"), x.channels.map((c) => ({ key: c.channel, label: t.has(`channels.${c.channel}`) ? t(`channels.${c.channel}`) : c.channel, value: share(c.orders, totalOrders), hint: money(c.revenueMinor) })), "insights-channels")}
        </div>
      </CardContent>
    </Card>
  );
}
