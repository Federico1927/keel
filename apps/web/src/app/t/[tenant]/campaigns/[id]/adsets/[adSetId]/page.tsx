import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isAdPlatformInPlan } from "@hullwise/config";
import { formatMoney, formatNumber } from "@hullwise/core";
import { and, eq, schema } from "@hullwise/db";
import { adRows, campaignAdSets, keywordRows, searchTermRows } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DetailShell, EmptyState, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { AdsTable, ordersHref } from "../../../ads-table";
import { AdBadges } from "../../../ads-badges";

export default async function AdSetPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string; adSetId: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
  const { tenant, id, adSetId } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [set] = await tx.select({ s: schema.adSets, campaignName: schema.campaigns.name }).from(schema.adSets).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adSets.campaignId)).where(and(eq(schema.adSets.tenantId, ctx.tenant.id), eq(schema.adSets.id, adSetId), eq(schema.adSets.campaignId, id))).limit(1);
    if (!set) return null;
    const [sets, ads, keywords, terms] = await Promise.all([campaignAdSets(s, at, period, id), adRows(s, at, period, { adSetId }), keywordRows(s, at, period, { adSetId, sort: "spend" }), searchTermRows(s, at, period, { adSetId, sort: "spend" })]);
    return { set, row: sets.rows.find((r) => r.id === adSetId)!, ads, keywords, terms };
  });
  if (!data || !isAdPlatformInPlan(data.set.s.platform, ctx.tenant.planKey)) notFound();
  const { set, row, ads, keywords, terms } = data;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const base = `/t/${tenant}/campaigns`;
  const google = set.s.platform === "google";
  const e = row.economics;
  return (
    <DetailShell
      back={<Link href={`${base}/${id}?${qs}`} className="hover:underline">← {set.campaignName}</Link>}
      eyebrow={`${set.s.platform.toUpperCase()} · ${t(set.s.platform === "meta" ? "ad_set" : "ad_group")} · ${set.s.externalId}`}
      title={set.s.name}
      chips={<Badge variant={set.s.status === "active" ? "success" : "muted"}>{t(`status.${set.s.status}`)}</Badge>}
      actions={<PeriodPicker basePath={`${base}/${id}/adsets/${adSetId}`} preset={period.preset} from={sp.from} to={sp.to} />}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("cols.spend")} value={money(row.metrics.spendMinor)} />
        <Stat label={t("cols.platform_conv")} value={`${formatNumber(Math.round(row.metrics.conversions), ctx.locale)} · ${money(row.metrics.conversionValueMinor)}`} />
        <Stat label={t("cols.hullwise_orders")} value={formatNumber(e.attributedOrders, ctx.locale)} href={ordersHref(tenant, row.orders, period, ctx.tenant.timezone) ?? undefined} />
        <Stat label={t("cols.profit")} value={money(e.profitMinor)} />
        <Stat label={t("cols.roas")} value={e.roas === null ? "—" : `${e.roas.toFixed(2)}×`} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("ads_title")}</CardTitle><CardDescription>{t("ads_description")}</CardDescription></CardHeader>
        <CardContent className="p-0">
          {ads.rows.length === 0 ? <EmptyState title={t("no_ads")} className="m-4" /> : (
            <AdsTable testId="ads-table" rowTestId="ad-row" currency={ctx.tenant.currency} locale={ctx.locale} extraHeads={[t("cols.frequency")]}
              rows={ads.rows.map((a) => ({ key: a.id, name: <Link href={`${base}/${id}/ads/${a.id}?${qs}`} className="hover:underline">{a.name}</Link>, sub: <AdBadges ad={a} />, metrics: a.metrics, economics: a.economics, ordersHref: ordersHref(tenant, a.orders, period, ctx.tenant.timezone), extra: [<span key="f" className="tabular">{a.frequency === null ? "—" : a.frequency.toFixed(1)}</span>] }))} />
          )}
        </CardContent>
      </Card>

      {google && (
        <>
          <Card className="mt-6">
            <CardHeader><CardTitle className="text-base">{t("keywords_title")}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {keywords.rows.length === 0 ? <EmptyState title={t("no_keywords")} className="m-4" /> : (
                <AdsTable testId="keywords-table" rowTestId="keyword-row" currency={ctx.tenant.currency} locale={ctx.locale} extraHeads={[t("cols.match"), t("cols.quality")]}
                  rows={keywords.rows.map((k) => ({ key: k.id, name: k.text, metrics: k.metrics, economics: k.economics, ordersHref: ordersHref(tenant, k.orders, period, ctx.tenant.timezone), extra: [<Badge key="m" variant="outline">{t(`match.${k.matchType}`)}</Badge>, <span key="q" className="tabular">{k.qualityScore ?? "—"}</span>] }))} />
              )}
            </CardContent>
          </Card>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">{t("search_terms_title")}</CardTitle>
              <CardDescription><Link href={`${base}/keywords?tab=search_terms&campaign=${id}&${qs}`} className="underline-offset-4 hover:underline">{t("all_search_terms")}</Link></CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {terms.rows.length === 0 ? <EmptyState title={t("no_search_terms")} className="m-4" /> : (
                <AdsTable testId="search-terms-table" rowTestId="search-term-row" currency={ctx.tenant.currency} locale={ctx.locale} emptyHullwise={t("hullwise_not_visible")}
                  rows={terms.rows.slice(0, 20).map((x) => ({ key: x.id, name: x.isOther ? t("other_terms") : x.text, muted: x.isOther, sub: <>{x.keywordText && <span>{t("via_keyword", { keyword: x.keywordText })}</span>}{x.candidate && <Badge variant="warning">{t(`negative_reason.${x.candidate}`)}</Badge>}{x.termStatus === "excluded" && <Badge variant="muted">{t("excluded")}</Badge>}</>, metrics: x.metrics, economics: x.economics, ordersHref: ordersHref(tenant, x.orders, period, ctx.tenant.timezone) }))} />
              )}
            </CardContent>
          </Card>
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("hullwise_footnote")}</p>
    </DetailShell>
  );
}
