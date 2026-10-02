import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage, isAdPlatformInPlan } from "@keel/config";
import { ADS_UTM_TEMPLATES, UTM_NONE, type AdPlatform, formatDate, formatMoney, formatNumber, formatPercent } from "@keel/core";
import { and, eq, schema } from "@keel/db";
import { adRows, campaignAdSets, campaignDailyLedger, campaignLinkSuggestions, campaignsWithEconomics, latestPlatformWrites, summarizeByProduct, variantStock } from "@keel/services";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DetailShell, EmptyState, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { RiskBadge } from "@/components/risk-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { ActionBadge, LightBadge } from "../badges";
import { CampaignStatusButton, LinkProductForm, LinkedProductControls } from "./campaign-actions";
import { SuggestionLinkButtons } from "./suggestion-buttons";
import { AdsTable, ordersHref } from "../ads-table";

export default async function CampaignDetailPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
  const { tenant, id } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("campaign_detail");
  const tl = await getTranslations("campaigns");
  const ta = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [row] = await campaignsWithEconomics(s, at, period, { campaignIds: [id] });
    if (!row) return null;
    const [ledger, suggestions, products, adSets, ads] = await Promise.all([
      campaignDailyLedger(s, at, period, [id]),
      campaignLinkSuggestions(s),
      tx.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.status, "active"))).orderBy(schema.products.title).limit(400),
      campaignAdSets(s, at, period, id),
      adRows(s, at, period, { campaignId: id }),
    ]);
    const productIds = row.products.map((p) => p.id);
    const stock = productIds.length ? summarizeByProduct(await variantStock(s, ctx.settings, { productIds })) : new Map();
    const platformWrite = (await latestPlatformWrites(s, "campaign", [id], { kinds: ["campaign.status"] })).get(id);
    return { row, ledger, suggestions: suggestions.find((g) => g.campaignId === id)?.suggestions ?? [], products, stock, platformWrite, adSets, ads };
  });
  // a campaign of an ad platform outside the plan (TikTok below Growth) is unreachable, even by URL
  if (!data || !isAdPlatformInPlan(data.row.platform, ctx.tenant.planKey)) notFound();
  const { row, ledger, suggestions, products, stock, platformWrite, adSets, ads } = data;
  const missingUtm = ads.rows.filter((a) => !a.utm.ok);
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/campaigns`;
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const canEdit = canWritePage(ctx.role, "campaigns");
  const canPause = canDo(ctx.role, "pause_campaign");
  const m = row.metrics;
  const linkedIds = new Set(row.products.map((p) => p.id));
  const suggestedReorder = [...stock.values()].reduce((s, p) => s + p.suggestedReorder, 0);
  const primary = row.products.find((p) => p.isPrimary) ?? row.products[0];

  return (
    <DetailShell
      back={<Link href={`${base}?${qs}`} className="hover:underline">← {t("back")}</Link>}
      eyebrow={`${row.platform.toUpperCase()} · ${row.externalId}`}
      title={row.name}
      chips={
        <>
          <Badge variant={row.status === "active" ? "success" : "muted"}>{tl(`status.${row.status}`)}</Badge>
          <LightBadge light={row.light} />
          <ActionBadge action={row.action} />
          <PlatformWriteStatus slug={tenant} write={platformWrite} canRetry={canDo(ctx.role, "pause_campaign")} showError />
        </>
      }
      actions={
        <div className="flex flex-col items-end gap-2">
          <PeriodPicker basePath={`${base}/${id}`} preset={period.preset} from={sp.from} to={sp.to} />
          <CampaignStatusButton slug={tenant} campaignId={row.id} platform={row.platform} status={row.status} canPause={canPause} readOnly={row.platform === "google"} />
        </div>
      }
      aside={
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("linked_products")}</CardTitle>
            <CardDescription>{tl(`reason.${row.reason}`)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {row.products.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("no_products")}</p>
            ) : (
              <ul className="divide-y text-sm">
                {row.products.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <Link href={`/t/${tenant}/products/${p.id}`} className="block truncate font-medium hover:underline">{p.title}</Link>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {p.isPrimary && <Badge variant="outline">{t("primary")}</Badge>}
                        <RiskBadge risk={p.risk} days={stock.get(p.id)?.worstDaysOfCover ?? null} />
                        <span className="tabular">{formatNumber(p.available, ctx.locale)}{p.incoming ? ` (+${formatNumber(p.incoming, ctx.locale)})` : ""}</span>
                      </span>
                    </span>
                    {canEdit && <LinkedProductControls slug={tenant} campaignId={row.id} productId={p.id} isPrimary={p.isPrimary} />}
                  </li>
                ))}
              </ul>
            )}
            {row.restock === "reorder" && primary && (
              <Alert>
                <AlertDescription className="space-y-2">
                  <p>{t("reorder_hint", { stock: formatNumber(row.stock ?? 0, ctx.locale), threshold: formatNumber(ctx.settings.campaignStockThreshold, ctx.locale), units: formatNumber(suggestedReorder, ctx.locale) })}</p>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/t/${tenant}/purchasing/new?product=${primary.id}`}>{t("create_po")}</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {canEdit && suggestions.filter((s) => !linkedIds.has(s.productId)).length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("suggestions")}</p>
                <SuggestionLinkButtons slug={tenant} campaignId={row.id} suggestions={suggestions.filter((s) => !linkedIds.has(s.productId))} />
              </div>
            )}
            {canEdit && <LinkProductForm slug={tenant} campaignId={row.id} products={products.filter((p) => !linkedIds.has(p.id))} hasLinks={row.products.length > 0} />}
          </CardContent>
        </Card>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("kpi.spend")} value={money(m.spendMinor)} hint={row.dailyBudgetMinor ? `${money(row.dailyBudgetMinor)}/d` : undefined} />
        <Stat label={t("kpi.orders")} value={formatNumber(m.attributedOrders, ctx.locale)} href={`/t/${tenant}/orders?campaign=${row.id}&from=${period.from.toISOString().slice(0, 10)}&to=${new Date(period.to.getTime() - 1).toISOString().slice(0, 10)}`} />
        <Stat label={t("kpi.revenue")} value={money(m.netRevenueMinor)} />
        <Stat label={t("kpi.margin")} value={money(m.marginMinor)} />
        <Stat label={t("kpi.profit")} value={money(m.profitMinor)} />
        <Stat label={t("kpi.roas")} value={m.roas === null ? "—" : `${m.roas.toFixed(2)}×`} />
        <Stat label={t("kpi.roi")} value={m.roi === null ? "—" : formatPercent(m.roi, ctx.locale)} />
        <Stat label={t("kpi.cpa")} value={m.cpaMinor === null ? "—" : money(m.cpaMinor)} />
        <Stat label={t("kpi.cpc")} value={m.cpcMinor === null ? "—" : money(m.cpcMinor)} />
        <Stat label={t("kpi.cr")} value={m.conversionRate === null ? "—" : formatPercent(m.conversionRate, ctx.locale)} />
      </div>

      <Card className="mt-6" data-testid="ad-sets">
        <CardHeader>
          <CardTitle className="text-base">{ta(row.platform === "meta" ? "ad_sets_title" : "ad_groups_title")}</CardTitle>
          <CardDescription>{ta("ad_sets_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          {missingUtm.length > 0 && (
            <Alert className="mx-4" data-testid="utm-missing">
              <AlertDescription className="space-y-1">
                <p>{ta("utm_missing", { n: missingUtm.length, total: ads.rows.length, params: [...new Set(missingUtm.flatMap((a) => a.utm.missing))].join(", ") })}</p>
                <code className="block break-all rounded bg-muted p-2 text-xs">{ADS_UTM_TEMPLATES[row.platform as AdPlatform] ?? ""}</code>
              </AlertDescription>
            </Alert>
          )}
          {adSets.rows.length === 0 ? (
            <EmptyState title={ta("no_ad_sets")} description={ta("no_ad_sets_hint")} className="m-4" />
          ) : (
            <AdsTable
              testId="ad-sets-table"
              rowTestId="ad-set-row"
              currency={ctx.tenant.currency}
              locale={ctx.locale}
              emptyKeel={ta("keel_not_visible")}
              rows={adSets.rows.map((s) => ({ key: s.id, name: <Link href={`${base}/${id}/adsets/${s.id}?${qs}`} className="hover:underline">{s.name}</Link>, sub: <>{ta("n_ads", { n: s.ads })}{s.keywords > 0 && <> · {ta("n_keywords", { n: s.keywords })}</>}{s.status !== "active" && <Badge variant="muted">{tl(`status.${s.status}`)}</Badge>}</>, metrics: s.metrics, economics: s.economics, ordersHref: ordersHref(tenant, s.orders, period, ctx.tenant.timezone) }))}
            />
          )}
          <div className="flex flex-wrap justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            {adSets.unassigned && <span data-testid="unassigned-orders">{ta("unassigned_orders", { n: adSets.unassigned.keel.allOrders })} · <Link className="underline-offset-4 hover:underline" href={ordersHref(tenant, row.platform === "meta" ? { campaign: id, utmTerm: UTM_NONE } : { campaign: id, utmContent: UTM_NONE }, period, ctx.tenant.timezone)!}>{ta("open_orders")}</Link></span>}
            <span data-testid="unallocated">{ta("reconciliation", { ads: money(adSets.reconciliation.childrenMinor), campaign: money(adSets.reconciliation.campaignMinor), unallocated: money(adSets.reconciliation.unallocatedMinor) })}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("daily")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {ledger.length === 0 ? (
            <EmptyState title={tl("empty_title")} description={tl("reason.no_data")} className="m-4" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ledger.date")}</TableHead>
                  <TableHead className="text-right">{t("ledger.spend")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("ledger.impressions")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("ledger.clicks")}</TableHead>
                  <TableHead className="text-right">{t("ledger.orders")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("ledger.revenue")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("ledger.margin")}</TableHead>
                  <TableHead className="text-right">{t("ledger.profit")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("ledger.roas")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.slice(0, 120).map((r) => (
                  <TableRow key={r.date}>
                    <TableCell>
                      {formatDate(new Date(`${r.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone)}
                      {r.flags.map((f) => (
                        <Badge key={f} variant="muted" className="ml-1">{t(`ledger.flags.${f}`)}</Badge>
                      ))}
                    </TableCell>
                    <TableCell className="text-right tabular">{money(r.spendMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(r.impressions, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(r.clicks, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.orders, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{money(r.netRevenueMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{money(r.marginMinor)}</TableCell>
                    <TableCell className={`text-right tabular ${r.profitMinor < 0 ? "text-destructive" : ""}`}>{money(r.profitMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.roas === null ? "—" : `${r.roas.toFixed(2)}×`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </DetailShell>
  );
}
