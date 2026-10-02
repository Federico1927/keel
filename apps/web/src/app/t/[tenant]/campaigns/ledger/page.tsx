import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatMoney, formatNumber } from "@hullwise/core";
import { campaignDailyLedger } from "@hullwise/services";
import { Badge, Button, Card, CardContent, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";

export default async function CampaignLedgerPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string; platform?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("campaign_ledger");
  const td = await getTranslations("campaign_detail");
  const period = resolvePeriod(sp, ctx.tenant.timezone, "7d");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const rows = (await ctx.run((tx) => campaignDailyLedger({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, period))).filter((r) => !sp.platform || r.platform === sp.platform);
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/campaigns`;
  const qs = new URLSearchParams(Object.entries({ ...periodParams(period, sp), platform: sp.platform }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodPicker basePath={`${base}/ledger`} keep={{ platform: sp.platform }} preset={period.preset} from={sp.from} to={sp.to} />
            <Button asChild size="sm" variant="outline">
              <a href={`${base}/ledger/export?${qs}`}>{t("export_csv")}</a>
            </Button>
          </div>
        }
      />
      <p className="mb-3 text-sm"><Link href={`${base}?${qs}`} className="hover:underline">← {td("back")}</Link></p>
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows.slice(0, 500)}
              rowKey={(r) => `${r.date}|${r.campaignId}`}
              rowProps={() => ({ "data-testid": "ledger-row" })}
              columns={[
                { key: "date", header: td("ledger.date"), mobile: "subtitle", className: "whitespace-nowrap", cell: (r) => <>{formatDate(new Date(`${r.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone)}<span className="uppercase md:hidden"> · {r.platform}</span></> },
                { key: "campaign", header: t("campaign"), mobile: "title", className: "md:max-w-[16rem]", cell: (r) => <><Link href={`${base}/${r.campaignId}?${qs}`} className="block truncate hover:underline">{r.campaignName}</Link>{r.flags.map((f) => <Badge key={f} variant="muted" className="mr-1 font-normal">{td(`ledger.flags.${f}`)}</Badge>)}</> },
                { key: "platform", header: t("platform"), className: "uppercase max-md:hidden", cell: (r) => r.platform },
                { key: "spend", header: td("ledger.spend"), align: "right", className: "tabular", cell: (r) => money(r.spendMinor) },
                { key: "impressions", header: td("ledger.impressions"), align: "right", priority: 3, className: "tabular", cell: (r) => formatNumber(r.impressions, ctx.locale) },
                { key: "clicks", header: td("ledger.clicks"), align: "right", priority: 3, className: "tabular", cell: (r) => formatNumber(r.clicks, ctx.locale) },
                { key: "orders", header: td("ledger.orders"), align: "right", className: "tabular", cell: (r) => formatNumber(r.orders, ctx.locale) },
                { key: "revenue", header: td("ledger.revenue"), align: "right", className: "tabular", cell: (r) => money(r.netRevenueMinor) },
                { key: "profit", header: td("ledger.profit"), mobile: "badge", align: "right", className: "tabular", cell: (r) => <span className={r.profitMinor < 0 ? "text-destructive" : ""}>{money(r.profitMinor)}</span> },
                { key: "roas", header: td("ledger.roas"), align: "right", className: "tabular", cell: (r) => (r.roas === null ? "—" : `${r.roas.toFixed(2)}×`) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
