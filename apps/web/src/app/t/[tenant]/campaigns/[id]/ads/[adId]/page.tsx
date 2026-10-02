import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, isAdPlatformInPlan } from "@hullwise/config";
import { ADS_UTM_TEMPLATES, type AdPlatform, formatDate, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { adDetail, canWriteAds, latestPlatformWrites } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardHeader, CardTitle, DataList, DetailShell, EmptyState, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { AdStatusButton } from "../../../ads-actions";
import { AdBadges } from "../../../ads-badges";
import { ordersHref } from "../../../ads-table";

export default async function AdPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string; adId: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
  const { tenant, id, adId } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const d = await adDetail(s, at, period, adId);
    if (!d || d.ad.campaignId !== id) return null;
    const write = (await latestPlatformWrites(s, "ad", [adId], { kinds: ["ad.status"] })).get(adId);
    return { ...d, write, canWrite: await canWriteAds(s, d.ad.platform) };
  });
  if (!data || !isAdPlatformInPlan(data.ad.platform, ctx.tenant.planKey)) notFound();
  const { ad, assets, days, write, canWrite } = data;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const base = `/t/${tenant}/campaigns`;
  const e = ad.economics;
  const canPause = canDo(ctx.role, "pause_campaign");
  return (
    <DetailShell
      back={<Link href={ad.adSetId ? `${base}/${id}/adsets/${ad.adSetId}?${qs}` : `${base}/${id}?${qs}`} className="hover:underline">← {ad.adSetName ?? ad.campaignName}</Link>}
      eyebrow={`${ad.platform.toUpperCase()} · ${ad.campaignName} · ${ad.externalId}`}
      title={ad.name}
      chips={<><AdBadges ad={ad} /><PlatformWriteStatus slug={tenant} write={write} canRetry={canPause} showError /></>}
      actions={<><PeriodPicker basePath={`${base}/${id}/ads/${adId}`} preset={period.preset} from={sp.from} to={sp.to} />{canPause && !canWrite && <AdStatusButton slug={tenant} adId={ad.id} platform={ad.platform} status={ad.status} canWrite={false} />}</>}
      // pause / resume: docked at the bottom on phones (#49)
      primaryActions={canPause && canWrite && ad.status !== "archived" ? <AdStatusButton slug={tenant} adId={ad.id} platform={ad.platform} status={ad.status} canWrite /> : undefined}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t("cols.spend")} value={money(ad.metrics.spendMinor)} />
        <Stat label={t("cols.ctr")} value={formatPercent(e.ctr, ctx.locale, 2)} hint={`${formatNumber(ad.metrics.impressions, ctx.locale)} · ${formatNumber(ad.metrics.clicks, ctx.locale)}`} />
        <Stat label={t("cols.frequency")} value={ad.frequency === null ? "—" : ad.frequency.toFixed(1)} hint={ad.fatigue?.ctrChange != null ? t("ctr_change", { change: formatPercent(ad.fatigue.ctrChange, ctx.locale, 0) }) : undefined} />
        <Stat label={t("cols.platform_conv")} value={`${formatNumber(Math.round(ad.metrics.conversions), ctx.locale)} · ${money(ad.metrics.conversionValueMinor)}`} />
        <Stat label={t("cols.hullwise_orders")} value={formatNumber(e.attributedOrders, ctx.locale)} href={ordersHref(tenant, ad.orders, period, ctx.tenant.timezone) ?? undefined} hint={e.excludedOrders ? t("excluded_n", { n: e.excludedOrders }) : undefined} />
        <Stat label={t("cols.revenue")} value={money(e.netRevenueMinor)} />
        <Stat label={t("cols.margin")} value={money(e.marginMinor)} />
        <Stat label={t("cols.profit")} value={money(e.profitMinor)} />
        <Stat label={t("cols.roas")} value={e.roas === null ? "—" : `${e.roas.toFixed(2)}×`} />
        <Stat label={t("cols.cpa")} value={e.cpaMinor === null ? "—" : money(e.cpaMinor)} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("copy_title")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {ad.headline && <p className="font-medium">{ad.headline}</p>}
          {ad.body && <p className="text-muted-foreground">{ad.body}</p>}
          {ad.finalUrl && <p className="break-all text-xs text-muted-foreground">{ad.finalUrl}</p>}
          {!ad.utm.ok && (
            <Alert data-testid="utm-missing"><AlertDescription className="space-y-1"><p>{t("utm_missing_ad", { params: ad.utm.missing.join(", ") })}</p><code className="block break-all rounded bg-muted p-2 text-xs">{ADS_UTM_TEMPLATES[ad.platform as AdPlatform] ?? ""}</code></AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("assets_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {assets.length === 0 ? <EmptyState title={t("no_assets")} description={t(`no_assets_${ad.platform === "meta" || ad.platform === "tiktok" ? ad.platform : "google"}`)} className="m-4" /> : (
            <DataList
              data-testid="assets-table"
              rows={assets}
              rowKey={(a) => a.id}
              rowProps={() => ({ "data-testid": "asset-row" })}
              columns={[
                { key: "asset", header: t("cols.asset"), mobile: "title", className: "md:max-w-[18rem] max-md:font-normal", cell: (a) => <><div className="truncate">{a.text ?? a.url ?? a.assetExternalId}</div>{a.type === "video" && a.url && <div className="truncate font-mono text-xs text-muted-foreground">{a.assetExternalId}</div>}<div className="flex flex-wrap gap-1">{a.performanceLabel && <Badge variant={a.performanceLabel === "LOW" ? "destructive" : a.performanceLabel === "BEST" ? "success" : "muted"}>{a.performanceLabel}</Badge>}{a.suggestion && <Badge variant="warning">{t(`pause_reason.${a.suggestion}`)}</Badge>}</div></> },
                { key: "field", header: t("cols.field"), mobile: "badge", cell: (a) => <Badge variant="outline">{t(`field.${a.fieldType}`)}</Badge> },
                { key: "spend", header: t("cols.spend"), align: "right", className: "tabular", cell: (a) => money(a.metrics.spendMinor) },
                { key: "impressions", header: t("cols.impressions"), align: "right", className: "tabular", cell: (a) => formatNumber(a.metrics.impressions, ctx.locale) },
                { key: "ctr", header: t("cols.ctr"), align: "right", className: "tabular", cell: (a) => formatPercent(a.economics.ctr, ctx.locale, 2) },
                { key: "conv", header: t("cols.platform_conv"), align: "right", priority: 2, className: "tabular", cell: (a) => formatNumber(Math.round(a.metrics.conversions), ctx.locale) },
                { key: "orders", header: t("cols.hullwise_orders_allocated"), align: "right", className: "tabular", cell: (a) => formatNumber(a.economics.attributedOrders, ctx.locale) },
                { key: "profit", header: t("cols.profit"), align: "right", className: "tabular max-md:font-semibold", cell: (a) => <span className={cn(a.economics.profitMinor < 0 && "text-destructive")}>{money(a.economics.profitMinor)}</span> },
              ]}
            />
          )}
          <p className="border-t p-3 text-xs text-muted-foreground">{t("assets_footnote")}</p>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("daily_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {days.length === 0 ? <EmptyState title={t("no_days")} className="m-4" /> : (
            <DataList
              rows={[...days].reverse().slice(0, 60)}
              rowKey={(d) => d.date}
              columns={[
                { key: "date", header: t("cols.date"), mobile: "title", className: "max-md:font-normal", cell: (d) => formatDate(new Date(`${d.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone) },
                { key: "spend", header: t("cols.spend"), mobile: "badge", align: "right", className: "tabular", cell: (d) => money(d.spendMinor) },
                { key: "impressions", header: t("cols.impressions"), align: "right", className: "tabular", cell: (d) => formatNumber(d.impressions, ctx.locale) },
                { key: "ctr", header: t("cols.ctr"), align: "right", className: "tabular", cell: (d) => formatPercent(d.impressions ? d.clicks / d.impressions : null, ctx.locale, 2) },
                { key: "frequency", header: t("cols.frequency"), align: "right", className: "tabular", cell: (d) => (d.reach ? (d.impressions / d.reach).toFixed(1) : "—") },
                { key: "conv", header: t("cols.platform_conv"), align: "right", priority: 2, className: "tabular", cell: (d) => formatNumber(d.purchases, ctx.locale) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </DetailShell>
  );
}
