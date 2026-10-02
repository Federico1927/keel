import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adPlatformsForPlan, canDo, canWritePage, isAnalyticsPlatformInPlan } from "@hullwise/config";
import { formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { adAccountNames, campaignLinkSuggestions, campaignsWithEconomics, trafficByCampaign } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, DataList } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { CampaignFilters } from "./filters";
import { SuggestionsPanel } from "./suggestions";
import { LightBadge, ActionBadge } from "./badges";
import { CampaignStatusButton } from "./[id]/campaign-actions";

export default async function CampaignsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string; platform?: string; status?: string; account?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("campaigns");
  const ta = await getTranslations("ads");
  const tg = await getTranslations("ga4.campaigns");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  // ad platforms of the plan only (TikTok from Growth): a platform outside it is neither filterable nor listed
  const platforms: readonly string[] = adPlatformsForPlan(ctx.tenant.planKey);
  const platform = platforms.includes(sp.platform ?? "") ? sp.platform : undefined;
  const status = ["active", "paused", "archived"].includes(sp.status ?? "") ? sp.status : undefined;
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  // ad accounts (#82): named on every row, filterable once a platform has more than one
  const accounts = await ctx.run((tx) => adAccountNames({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } }));
  const accountFilter = accounts.find((a) => a.externalId === sp.account && platforms.includes(a.provider));
  const account = accountFilter?.externalId;
  const [rows, suggestions, ga4Sessions] = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [list, sugg] = await Promise.all([campaignsWithEconomics(s, at, period, { platform, status, ...(accountFilter ? { account: { provider: accountFilter.provider, externalId: accountFilter.externalId, primary: accountFilter.primary } } : {}) }), campaignLinkSuggestions(s)]);
    // GA4 sessions per campaign (#86), matched on the UTM campaign; null when GA4 is not connected (no column)
    const sessions = isAnalyticsPlatformInPlan(ctx.tenant.planKey) ? await trafficByCampaign(s, { timezone: ctx.tenant.timezone }, period) : null;
    return [list.filter((r) => platforms.includes(r.platform)), sugg.filter((r) => platforms.includes(r.platform)), sessions] as const;
  });
  const primaryOf = new Map(accounts.filter((a) => a.primary).map((a) => [a.provider, a.externalId]));
  const accountName = (r: { platform: string; accountExternalId: string | null }) => {
    const ext = r.accountExternalId ?? primaryOf.get(r.platform);
    return accounts.find((a) => a.provider === r.platform && a.externalId === ext)?.name ?? null;
  };
  const multiAccount = accounts.filter((a) => platforms.includes(a.provider)).length > 1;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const ratio = (r: number | null) => (r === null ? "—" : `${r.toFixed(2)}×`);
  const base = `/t/${tenant}/campaigns`;
  const keep = { ...periodParams(period, sp), platform, status, account };
  const qs = new URLSearchParams(Object.entries(keep).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const totals = rows.reduce((a, r) => ({ spend: a.spend + r.metrics.spendMinor, orders: a.orders + r.metrics.attributedOrders, revenue: a.revenue + r.metrics.netRevenueMinor, profit: a.profit + r.metrics.profitMinor }), { spend: 0, orders: 0, revenue: 0, profit: 0 });
  const canEdit = canWritePage(ctx.role, "campaigns");
  const canPause = canDo(ctx.role, "pause_campaign");

  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodPicker basePath={base} keep={{ platform, status, account }} preset={period.preset} from={sp.from} to={sp.to} />
            <Link href={`${base}/ledger?${qs}`} className="text-sm underline-offset-4 hover:underline">{t("ledger")}</Link>
            <Link href={`${base}/creatives?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="creatives-link">{t("creatives_link")}</Link>
            <Link href={`${base}/keywords?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="keywords-link">{ta("nav.keywords")}</Link>
            <Link href={`${base}/words?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="words-link">{ta("nav.words")}</Link>
            <Link href={`${base}/recommendations?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="recommendations-link">{ta("nav.recommendations")}</Link>
          </div>
        }
      />
      <CampaignFilters basePath={base} keep={periodParams(period, sp)} platform={platform} status={status} platforms={platforms} account={account} accounts={multiAccount ? accounts.filter((a) => platforms.includes(a.provider) && (a.connected || rows.some((r) => r.accountExternalId === a.externalId))).map((a) => ({ value: a.externalId, label: a.name })) : []} />
      {rows.length > 0 && (() => {
        const byPlatform = platforms.map((p) => {
          const rs = rows.filter((r) => r.platform === p);
          return { platform: p, spend: rs.reduce((s, r) => s + r.metrics.spendMinor, 0), declared: rs.reduce((s, r) => s + r.declared.purchases, 0), declaredValue: rs.reduce((s, r) => s + r.declared.valueMinor, 0), real: rs.reduce((s, r) => s + r.metrics.attributedOrders, 0), realRevenue: rs.reduce((s, r) => s + r.metrics.netRevenueMinor, 0) };
        }).filter((x) => x.spend > 0 || x.declared > 0);
        return (
          <Card className="mt-4" data-testid="declared-vs-real">
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {byPlatform.map((x) => {
                const gap = x.declared ? (x.real - x.declared) / x.declared : null;
                return (
                  <div key={x.platform} className="space-y-1 text-sm">
                    <p className="font-medium">{t(`declared.title_${x.platform}`)}</p>
                    <div className="flex flex-wrap justify-between gap-x-2"><span className="text-muted-foreground">{t("declared.platform_says")}</span><span className="tabular">{x.declared} · {money(x.declaredValue)} · {ratio(x.spend ? x.declaredValue / x.spend : null)}</span></div>
                    <div className="flex flex-wrap justify-between gap-x-2"><span className="text-muted-foreground">{t("declared.real")}</span><span className="tabular">{x.real} · {money(x.realRevenue)} · {ratio(x.spend ? x.realRevenue / x.spend : null)}</span></div>
                    <div className="flex flex-wrap justify-between gap-x-2"><span className="text-muted-foreground">{t("declared.gap")}</span><span className={`tabular font-medium ${gap !== null && gap < -0.2 ? "text-destructive" : ""}`}>{gap === null ? "—" : `${gap > 0 ? "+" : ""}${Math.round(gap * 100)}%`}</span></div>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{t("declared.help")}</p>
            </CardContent>
          </Card>
        );
      })()}
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "campaign-row" })}
              footer={{ campaign: t("totals"), spend: money(totals.spend), orders: formatNumber(totals.orders, ctx.locale), revenue: money(totals.revenue), profit: <span className={totals.profit < 0 ? "text-destructive" : ""}>{money(totals.profit)}</span> }}
              columns={[
                { key: "campaign", header: t("columns.campaign"), mobile: "title", className: "md:max-w-[18rem]", cell: (r) => <><Link href={`${base}/${r.id}?${qs}`} className="block truncate font-medium hover:underline">{r.name}</Link><span className="text-xs font-normal text-muted-foreground"><span className="uppercase">{r.platform}</span>{accountName(r) && <span data-testid="campaign-account"> · {accountName(r)}</span>} · {t("linked_n", { n: r.products.length })}</span></> },
                { key: "status", header: t("columns.status"), priority: 2, label: "", cell: (r) => <Badge variant={r.status === "active" ? "success" : "muted"}>{t(`status.${r.status}`)}</Badge> },
                { key: "spend", header: t("columns.spend"), align: "right", className: "tabular", cell: (r) => money(r.metrics.spendMinor) },
                { key: "orders", header: t("columns.orders"), align: "right", className: "tabular", cell: (r) => formatNumber(r.metrics.attributedOrders, ctx.locale) },
                ...(ga4Sessions ? [{ key: "ga4", header: tg("sessions"), align: "right" as const, className: "tabular", cell: (r: (typeof rows)[number]) => {
                  const n = ga4Sessions.get(r.id) ?? 0;
                  return n ? <Link href={`/t/${tenant}/analytics/traffic?${new URLSearchParams(Object.entries({ ...periodParams(period, sp), campaignId: r.id }).filter((e): e is [string, string] => Boolean(e[1])))}`} className="underline-offset-4 hover:underline" data-testid="campaign-ga4-sessions" title={tg("cr_title")}>{formatNumber(n, ctx.locale)} <span className="text-xs text-muted-foreground">· {formatPercent(r.metrics.attributedOrders / n, ctx.locale, 2)}</span></Link> : "—";
                } }] : []),
                { key: "revenue", header: t("columns.revenue"), mobile: "detail", align: "right", className: "tabular", cell: (r) => money(r.metrics.netRevenueMinor) },
                { key: "margin", header: t("columns.margin"), mobile: "detail", priority: 3, align: "right", className: "tabular", cell: (r) => money(r.metrics.marginMinor) },
                { key: "profit", header: t("columns.profit"), align: "right", className: "tabular font-medium", cell: (r) => <span className={r.metrics.profitMinor < 0 ? "text-destructive" : ""}>{money(r.metrics.profitMinor)}</span> },
                { key: "roas", header: t("columns.roas"), priority: 2, align: "right", className: "tabular", cell: (r) => ratio(r.metrics.roas) },
                { key: "roi", header: t("columns.roi"), mobile: "detail", priority: 2, align: "right", className: "tabular", cell: (r) => (r.metrics.roi === null ? "—" : formatPercent(r.metrics.roi, ctx.locale)) },
                { key: "cpa", header: t("columns.cpa"), mobile: "detail", priority: 3, align: "right", className: "tabular", cell: (r) => (r.metrics.cpaMinor === null ? "—" : money(r.metrics.cpaMinor)) },
                { key: "light", header: t("columns.light"), mobile: "badge", cell: (r) => <LightBadge light={r.light} /> },
                { key: "action", header: t("columns.action"), label: "", cell: (r) => <ActionBadge action={r.action} /> },
                { key: "stock", header: t("columns.stock"), mobile: "detail", priority: 3, align: "right", className: "tabular", cell: (r) => (r.stock === null ? "—" : `${formatNumber(r.stock, ctx.locale)}${r.incoming ? ` (+${formatNumber(r.incoming, ctx.locale)})` : ""}`) },
                // phones: pause a losing campaign from the list, with the same confirmation as the detail page (#49)
                { key: "quick", header: "", mobile: "action", className: "md:hidden", headClassName: "md:hidden", cell: (r) => (canPause && r.status === "active" && r.action.startsWith("pause") && r.platform !== "google" ? <CampaignStatusButton slug={tenant} campaignId={r.id} platform={r.platform} status={r.status} canPause readOnly={false} size="sm" className="w-full" /> : null) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <SuggestionsPanel slug={tenant} groups={suggestions} canEdit={canEdit} />
    </>
  );
}
