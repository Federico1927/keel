import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { and, eq, schema } from "@hullwise/db";
import { ADS_TABLE_SORTS, canWriteAds, keywordRows, searchTermRows, type AdsTableSort } from "@hullwise/services";
import { Badge, Button, Card, CardContent, EmptyState, Input, PageHeader, Select, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { AdsNav, AdsTable, ordersHref } from "../ads-table";
import { NegativeKeywordButton } from "../ads-actions";

type SP = { preset?: string; from?: string; to?: string; tab?: string; q?: string; campaign?: string; sort?: string; candidates?: string; page?: string };

export default async function KeywordsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<SP> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const tab = sp.tab === "search_terms" ? "search_terms" : "keywords";
  const sort = (ADS_TABLE_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as AdsTableSort) : "spend";
  const candidates = sp.candidates === "1";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const campaigns = await tx.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.platform, "google"))).orderBy(schema.campaigns.name);
    const campaign = campaigns.some((c) => c.id === sp.campaign) ? sp.campaign : undefined;
    const filters = { campaignId: campaign, q: sp.q?.trim() || undefined, sort, page };
    const result = tab === "keywords" ? { kind: "keywords" as const, ...(await keywordRows(s, at, period, filters)) } : { kind: "search_terms" as const, ...(await searchTermRows(s, at, period, { ...filters, candidatesOnly: candidates })) };
    return { campaigns, campaign, result, canWrite: await canWriteAds(s, "google") };
  });
  const { campaigns, campaign, result, canWrite } = data;
  const keep = { ...periodParams(period, sp), tab, q: sp.q, campaign, sort, candidates: candidates ? "1" : undefined };
  const href = (patch: Record<string, string | undefined>) => `/t/${tenant}/campaigns/keywords?${new URLSearchParams(Object.entries({ ...keep, ...patch }).filter((e): e is [string, string] => Boolean(e[1])))}`;
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const canPause = canDo(ctx.role, "pause_campaign");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("keywords_page_title")} description={t("keywords_page_description")} actions={<PeriodPicker basePath={`/t/${tenant}/campaigns/keywords`} keep={{ tab, q: sp.q, campaign, sort, candidates: keep.candidates }} preset={period.preset} from={sp.from} to={sp.to} />} />
      <AdsNav tenant={tenant} active="keywords" qs={qs} />
      <div className="mb-3 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
        {(["keywords", "search_terms"] as const).map((k) => <Link key={k} href={href({ tab: k, page: undefined, candidates: undefined })} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`tab-${k}`}>{t(`tabs.${k}`)}</Link>)}
      </div>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value={tab} />
        {period.preset ? <input type="hidden" name="preset" value={period.preset} /> : <><input type="hidden" name="from" value={sp.from ?? ""} /><input type="hidden" name="to" value={sp.to ?? ""} /></>}
        <Input name="q" defaultValue={sp.q ?? ""} placeholder={t("search_placeholder")} aria-label={t("search_placeholder")} className="w-56" />
        <Select name="campaign" defaultValue={campaign ?? ""} aria-label={t("cols.campaign")} wrapperClassName="w-56">
          <option value="">{t("all_campaigns")}</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select name="sort" defaultValue={sort} aria-label={t("sort_label")} wrapperClassName="w-40">
          {ADS_TABLE_SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}`)}</option>)}
        </Select>
        {tab === "search_terms" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="candidates" value="1" defaultChecked={candidates} /> {t("candidates_only")}</label>}
        <Button type="submit" size="sm" variant="outline">{t("apply")}</Button>
      </form>
      {result.rows.length === 0 ? <EmptyState title={t(tab === "keywords" ? "no_keywords" : "no_search_terms")} description={t("google_only")} /> : (
        <Card>
          <CardContent className="p-0">
            {result.kind === "keywords" ? (
              <AdsTable testId="keywords-table" rowTestId="keyword-row" currency={ctx.tenant.currency} locale={ctx.locale} extraHeads={[t("cols.match"), t("cols.quality")]}
                rows={result.rows.map((k) => ({ key: k.id, name: k.text, sub: <><Link href={`/t/${tenant}/campaigns/${k.campaignId}?${qs}`} className="hover:underline">{k.campaignName}</Link>{k.adSetName && k.adSetId && <> · <Link href={`/t/${tenant}/campaigns/${k.campaignId}/adsets/${k.adSetId}?${qs}`} className="hover:underline">{k.adSetName}</Link></>}</>, metrics: k.metrics, economics: k.economics, ordersHref: ordersHref(tenant, k.orders, period, ctx.tenant.timezone), extra: [<Badge key="m" variant="outline">{t(`match.${k.matchType}`)}</Badge>, <span key="q" className={cn("tabular", (k.qualityScore ?? 10) <= 4 && "text-destructive")}>{k.qualityScore ?? "—"}</span>] }))} />
            ) : (
              <AdsTable testId="search-terms-table" rowTestId="search-term-row" currency={ctx.tenant.currency} locale={ctx.locale} emptyHullwise={t("hullwise_not_visible")} extraHeads={[t("cols.action")]}
                rows={result.rows.map((x) => ({ key: x.id, muted: x.isOther, name: x.isOther ? t("other_terms") : x.text, sub: <>{x.campaignName}{x.keywordText && <> · {t("via_keyword", { keyword: x.keywordText })}</>}{x.candidate && <Badge variant="warning" data-testid="negative-candidate">{t(`negative_reason.${x.candidate}`)}</Badge>}{x.termStatus === "excluded" && <Badge variant="muted">{t("excluded")}</Badge>}</>, metrics: x.metrics, economics: x.economics, ordersHref: ordersHref(tenant, x.orders, period, ctx.tenant.timezone), extra: [canPause && !x.isOther && x.termStatus !== "excluded" ? <NegativeKeywordButton key="n" slug={tenant} termId={x.id} text={x.text} canWrite={canWrite} hasAdGroup={Boolean(x.adSetId)} /> : null] }))} />
            )}
            <div className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
              <span>{t("rows_total", { n: result.total })}</span>
              <span className="flex gap-3">
                {result.page > 1 && <Link href={href({ page: String(result.page - 1) })} className="underline-offset-4 hover:underline">{t("prev")}</Link>}
                <span>{t("page_of", { page: result.page, pages: result.pages })}</span>
                {result.page < result.pages && <Link href={href({ page: String(result.page + 1) })} className="underline-offset-4 hover:underline">{t("next")}</Link>}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t(tab === "keywords" ? "keywords_footnote" : "search_terms_footnote")}</p>
    </>
  );
}
