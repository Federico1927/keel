import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { ADS_UTM_TEMPLATES, formatMoney, formatNumber, formatPercent } from "@keel/core";
import { adsRecommendations, canWriteAds } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { AdsNav } from "../ads-table";
import { NegativeKeywordButton } from "../ads-actions";

/** Read-only suggestions a person acts on: negative keywords, ads and assets to pause, winning words, missing UTM templates. */
export default async function AdsRecommendationsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ preset?: string; from?: string; to?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone, "90d");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const { recs, canWrite } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { recs: await adsRecommendations(s, at, period, { langs: [ctx.tenant.defaultLocale, ctx.locale] }), canWrite: await canWriteAds(s, "google") };
  });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const base = `/t/${tenant}/campaigns`;
  const canPause = canDo(ctx.role, "pause_campaign");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("recommendations_title")} description={t("recommendations_description")} actions={<PeriodPicker basePath={`${base}/recommendations`} preset={period.preset} from={sp.from} to={sp.to} />} />
      <AdsNav tenant={tenant} active="recommendations" qs={qs} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card data-testid="rec-negatives">
          <CardHeader>
            <CardTitle className="text-base">{t("rec.negatives_title")}</CardTitle>
            <CardDescription>{t("rec.negatives_description", { n: recs.negativeTotal })}{!canWrite && ` ${t("rec.google_read_only")}`}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {recs.negatives.length === 0 ? <EmptyState title={t("rec.none")} className="m-4" /> : (
              <Table>
                <TableHeader><TableRow><TableHead>{t("cols.search_term")}</TableHead><TableHead className="text-right">{t("cols.spend")}</TableHead><TableHead className="hidden text-right sm:table-cell">{t("cols.clicks")}</TableHead><TableHead>{t("cols.reason")}</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {recs.negatives.map((n) => (
                    <TableRow key={n.id} data-testid="rec-negative-row">
                      <TableCell className="max-w-[14rem]"><div className="truncate font-medium">{n.text}</div><div className="truncate text-xs text-muted-foreground">{n.campaignName}</div></TableCell>
                      <TableCell className="text-right tabular">{money(n.metrics.spendMinor)}</TableCell>
                      <TableCell className="hidden text-right tabular sm:table-cell">{formatNumber(n.metrics.clicks, ctx.locale)}</TableCell>
                      <TableCell><Badge variant="warning">{t(`negative_reason.${n.candidate}`)}</Badge></TableCell>
                      <TableCell>{canPause && <NegativeKeywordButton slug={tenant} termId={n.id} text={n.text} canWrite={canWrite} hasAdGroup={Boolean(n.adSetId)} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="border-t p-3 text-xs"><Link href={`${base}/keywords?tab=search_terms&candidates=1&${qs}`} className="underline-offset-4 hover:underline">{t("rec.all_candidates")}</Link></p>
          </CardContent>
        </Card>

        <Card data-testid="rec-ads">
          <CardHeader><CardTitle className="text-base">{t("rec.ads_title")}</CardTitle><CardDescription>{t("rec.ads_description")}</CardDescription></CardHeader>
          <CardContent className="p-0">
            {recs.ads.length === 0 ? <EmptyState title={t("rec.none")} className="m-4" /> : (
              <Table>
                <TableHeader><TableRow><TableHead>{t("cols.ad")}</TableHead><TableHead className="text-right">{t("cols.spend")}</TableHead><TableHead className="text-right">{t("cols.profit")}</TableHead><TableHead>{t("cols.reason")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {recs.ads.map((a) => (
                    <TableRow key={a.id} data-testid="rec-ad-row">
                      <TableCell className="max-w-[16rem]"><Link href={`${base}/${a.campaignId}/ads/${a.id}?${qs}`} className="block truncate font-medium hover:underline">{a.name}</Link><div className="truncate text-xs text-muted-foreground">{a.campaignName}</div></TableCell>
                      <TableCell className="text-right tabular">{money(a.metrics.spendMinor)}</TableCell>
                      <TableCell className="text-right tabular text-destructive">{money(a.economics.profitMinor)}</TableCell>
                      <TableCell><Badge variant="destructive">{t(`pause_reason.${a.suggestion}`)}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card data-testid="rec-words">
          <CardHeader><CardTitle className="text-base">{t("rec.words_title")}</CardTitle><CardDescription>{t("rec.words_description")}</CardDescription></CardHeader>
          <CardContent>
            {recs.words.length === 0 ? <p className="text-sm text-muted-foreground">{t("rec.none")}</p> : (
              <ul className="space-y-1 text-sm">
                {recs.words.map((w) => <li key={w.phrase} className="flex items-center justify-between gap-2" data-testid="rec-word"><span className="font-medium">{w.phrase}</span><span className="tabular text-muted-foreground">{money(w.profitMinor)} · {w.roas === null ? "—" : `${w.roas.toFixed(2)}×`} · {t("in_items", { n: w.items })}</span></li>)}
              </ul>
            )}
            <p className="mt-3 text-xs"><Link href={`${base}/words?${qs}`} className="underline-offset-4 hover:underline">{t("rec.open_words")}</Link></p>
          </CardContent>
        </Card>

        <Card data-testid="rec-assets">
          <CardHeader><CardTitle className="text-base">{t("rec.assets_title")}</CardTitle><CardDescription>{t("rec.assets_description")}</CardDescription></CardHeader>
          <CardContent className="p-0">
            {recs.assets.length === 0 ? <EmptyState title={t("rec.none")} className="m-4" /> : (
              <Table>
                <TableHeader><TableRow><TableHead>{t("cols.asset")}</TableHead><TableHead className="text-right">{t("cols.ctr")}</TableHead><TableHead>{t("cols.reason")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {recs.assets.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="max-w-[16rem]"><div className="truncate font-medium">{a.text ?? t(`field.${a.fieldType}`)}</div><Link href={`${base}/${a.campaignId}/ads/${a.adId}?${qs}`} className="block truncate text-xs text-muted-foreground hover:underline">{a.adName}</Link></TableCell>
                      <TableCell className="text-right tabular">{formatPercent(a.economics.ctr, ctx.locale, 2)}</TableCell>
                      <TableCell><Badge variant="warning">{t(`pause_reason.${a.suggestion}`)}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2" data-testid="rec-utm">
          <CardHeader><CardTitle className="text-base">{t("rec.utm_title")}</CardTitle><CardDescription>{t("rec.utm_description")}</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {recs.utm.length === 0 ? <p className="text-muted-foreground">{t("rec.utm_ok")}</p> : (
              <ul className="space-y-1">
                {recs.utm.map((u) => <li key={u.campaignId} className="flex flex-wrap items-center justify-between gap-2" data-testid="rec-utm-row"><Link href={`${base}/${u.campaignId}?${qs}`} className="font-medium hover:underline">{u.campaignName}</Link><span className="text-muted-foreground">{t("rec.utm_row", { missing: u.missing, ads: u.ads, params: u.params.join(", ") })}</span></li>)}
              </ul>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {(["meta", "google"] as const).map((p) => <div key={p}><p className="text-xs font-medium">{t(`rec.template_${p}`)}</p><code className="block break-all rounded bg-muted p-2 text-xs">{ADS_UTM_TEMPLATES[p]}</code></div>)}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
