import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatMoney, formatNumber } from "@keel/core";
import { campaignDailyLedger } from "@keel/services";
import { Badge, Button, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{td("ledger.date")}</TableHead>
                  <TableHead>{t("campaign")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("platform")}</TableHead>
                  <TableHead className="text-right">{td("ledger.spend")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{td("ledger.impressions")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{td("ledger.clicks")}</TableHead>
                  <TableHead className="text-right">{td("ledger.orders")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{td("ledger.revenue")}</TableHead>
                  <TableHead className="text-right">{td("ledger.profit")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{td("ledger.roas")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 500).map((r) => (
                  <TableRow key={`${r.date}|${r.campaignId}`}>
                    <TableCell className="whitespace-nowrap">{formatDate(new Date(`${r.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone)}</TableCell>
                    <TableCell className="max-w-[16rem]">
                      <Link href={`${base}/${r.campaignId}?${qs}`} className="block truncate hover:underline">{r.campaignName}</Link>
                      {r.flags.map((f) => (
                        <Badge key={f} variant="muted" className="mr-1">{td(`ledger.flags.${f}`)}</Badge>
                      ))}
                    </TableCell>
                    <TableCell className="hidden uppercase md:table-cell">{r.platform}</TableCell>
                    <TableCell className="text-right tabular">{money(r.spendMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(r.impressions, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(r.clicks, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.orders, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{money(r.netRevenueMinor)}</TableCell>
                    <TableCell className={`text-right tabular ${r.profitMinor < 0 ? "text-destructive" : ""}`}>{money(r.profitMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.roas === null ? "—" : `${r.roas.toFixed(2)}×`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
