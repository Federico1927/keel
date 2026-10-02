import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatMoney, formatNumber, formatPercent } from "@keel/core";
import { campaignLinkSuggestions, campaignsWithEconomics } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { CampaignFilters } from "./filters";
import { SuggestionsPanel } from "./suggestions";
import { LightBadge, ActionBadge } from "./badges";

export default async function CampaignsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string; platform?: string; status?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("campaigns");
  const ta = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const platform = ["meta", "google"].includes(sp.platform ?? "") ? sp.platform : undefined;
  const status = ["active", "paused", "archived"].includes(sp.status ?? "") ? sp.status : undefined;
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const [rows, suggestions] = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return Promise.all([campaignsWithEconomics(s, at, period, { platform, status }), campaignLinkSuggestions(s)]);
  });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const ratio = (r: number | null) => (r === null ? "—" : `${r.toFixed(2)}×`);
  const base = `/t/${tenant}/campaigns`;
  const keep = { ...periodParams(period, sp), platform, status };
  const qs = new URLSearchParams(Object.entries(keep).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const totals = rows.reduce((a, r) => ({ spend: a.spend + r.metrics.spendMinor, orders: a.orders + r.metrics.attributedOrders, revenue: a.revenue + r.metrics.netRevenueMinor, profit: a.profit + r.metrics.profitMinor }), { spend: 0, orders: 0, revenue: 0, profit: 0 });
  const canEdit = canWritePage(ctx.role, "campaigns");

  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodPicker basePath={base} keep={{ platform, status }} preset={period.preset} from={sp.from} to={sp.to} />
            <Link href={`${base}/ledger?${qs}`} className="text-sm underline-offset-4 hover:underline">{t("ledger")}</Link>
            <Link href={`${base}/creatives?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="creatives-link">{t("creatives_link")}</Link>
            <Link href={`${base}/keywords?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="keywords-link">{ta("nav.keywords")}</Link>
            <Link href={`${base}/words?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="words-link">{ta("nav.words")}</Link>
            <Link href={`${base}/recommendations?${qs}`} className="text-sm underline-offset-4 hover:underline" data-testid="recommendations-link">{ta("nav.recommendations")}</Link>
          </div>
        }
      />
      <CampaignFilters basePath={base} keep={periodParams(period, sp)} platform={platform} status={status} />
      {rows.length > 0 && (() => {
        const byPlatform = ["meta", "google"].map((p) => {
          const rs = rows.filter((r) => r.platform === p);
          return { platform: p, spend: rs.reduce((s, r) => s + r.metrics.spendMinor, 0), declared: rs.reduce((s, r) => s + r.declared.purchases, 0), declaredValue: rs.reduce((s, r) => s + r.declared.valueMinor, 0), real: rs.reduce((s, r) => s + r.metrics.attributedOrders, 0), realRevenue: rs.reduce((s, r) => s + r.metrics.netRevenueMinor, 0) };
        }).filter((x) => x.spend > 0 || x.declared > 0);
        return (
          <Card className="mt-4" data-testid="declared-vs-real">
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              {byPlatform.map((x) => {
                const gap = x.declared ? (x.real - x.declared) / x.declared : null;
                return (
                  <div key={x.platform} className="space-y-1 text-sm">
                    <p className="font-medium">{t(`declared.title_${x.platform}`)}</p>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("declared.platform_says")}</span><span className="tabular">{x.declared} · {money(x.declaredValue)} · {ratio(x.spend ? x.declaredValue / x.spend : null)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("declared.real")}</span><span className="tabular">{x.real} · {money(x.realRevenue)} · {ratio(x.spend ? x.realRevenue / x.spend : null)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("declared.gap")}</span><span className={`tabular font-medium ${gap !== null && gap < -0.2 ? "text-destructive" : ""}`}>{gap === null ? "—" : `${gap > 0 ? "+" : ""}${Math.round(gap * 100)}%`}</span></div>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground sm:col-span-2">{t("declared.help")}</p>
            </CardContent>
          </Card>
        );
      })()}
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.campaign")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.spend")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.orders")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.revenue")}</TableHead>
                  <TableHead className="hidden text-right xl:table-cell">{t("columns.margin")}</TableHead>
                  <TableHead className="text-right">{t("columns.profit")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.roas")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.roi")}</TableHead>
                  <TableHead className="hidden text-right xl:table-cell">{t("columns.cpa")}</TableHead>
                  <TableHead>{t("columns.light")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.action")}</TableHead>
                  <TableHead className="hidden text-right xl:table-cell">{t("columns.stock")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="campaign-row">
                    <TableCell className="max-w-[18rem]">
                      <Link href={`${base}/${r.id}?${qs}`} className="block truncate font-medium hover:underline">{r.name}</Link>
                      <span className="text-xs uppercase text-muted-foreground">{r.platform} · {t("linked_n", { n: r.products.length })}</span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell"><Badge variant={r.status === "active" ? "success" : "muted"}>{t(`status.${r.status}`)}</Badge></TableCell>
                    <TableCell className="text-right tabular">{money(r.metrics.spendMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(r.metrics.attributedOrders, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{money(r.metrics.netRevenueMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular xl:table-cell">{money(r.metrics.marginMinor)}</TableCell>
                    <TableCell className={`text-right tabular font-medium ${r.metrics.profitMinor < 0 ? "text-destructive" : ""}`}>{money(r.metrics.profitMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{ratio(r.metrics.roas)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{r.metrics.roi === null ? "—" : formatPercent(r.metrics.roi, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular xl:table-cell">{r.metrics.cpaMinor === null ? "—" : money(r.metrics.cpaMinor)}</TableCell>
                    <TableCell><LightBadge light={r.light} /></TableCell>
                    <TableCell className="hidden md:table-cell"><ActionBadge action={r.action} /></TableCell>
                    <TableCell className="hidden text-right tabular xl:table-cell">{r.stock === null ? "—" : `${formatNumber(r.stock, ctx.locale)}${r.incoming ? ` (+${formatNumber(r.incoming, ctx.locale)})` : ""}`}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 font-medium">
                  <TableCell>{t("totals")}</TableCell>
                  <TableCell className="hidden lg:table-cell" />
                  <TableCell className="text-right tabular">{money(totals.spend)}</TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(totals.orders, ctx.locale)}</TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">{money(totals.revenue)}</TableCell>
                  <TableCell className="hidden xl:table-cell" />
                  <TableCell className={`text-right tabular ${totals.profit < 0 ? "text-destructive" : ""}`}>{money(totals.profit)}</TableCell>
                  <TableCell className="hidden lg:table-cell" />
                  <TableCell className="hidden lg:table-cell" />
                  <TableCell className="hidden xl:table-cell" />
                  <TableCell />
                  <TableCell className="hidden md:table-cell" />
                  <TableCell className="hidden xl:table-cell" />
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <SuggestionsPanel slug={tenant} groups={suggestions} canEdit={canEdit} />
    </>
  );
}
