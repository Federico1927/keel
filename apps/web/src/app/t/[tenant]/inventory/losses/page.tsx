import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { unexplainedLosses } from "@hullwise/services";
import { Badge, Button, Card, CardContent, DataList, EmptyState, PageHeader, Select, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { stockLocations, svcOf } from "@/server/queries/inventory-control";

export default async function LossesPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string; location?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("inventory_control");
  const period = resolvePeriod(sp, ctx.tenant.timezone, "30d");
  const locations = await stockLocations(ctx);
  const locationId = locations.some((l) => l.id === sp.location) ? sp.location! : null;
  const r = await ctx.run((tx) => unexplainedLosses(svcOf(ctx, tx), { from: period.from, to: period.to, locationId }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/inventory/losses`;
  const keep = periodParams(period, sp);
  return (
    <>
      <Link href={`/t/${tenant}/inventory`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("losses.title")} description={t("losses.description")} actions={<PeriodPicker basePath={base} keep={{ location: locationId ?? undefined }} preset={period.preset} from={sp.from} to={sp.to} />} />
      <form className="mb-4 flex flex-wrap items-center gap-2" method="get">
        {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <Select size="sm" name="location" defaultValue={locationId ?? ""} className="w-auto" aria-label={t("losses.location")}>
          <option value="">{t("losses.all_locations")}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="secondary">{t("losses.apply")}</Button>
      </form>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("losses.kpi.units")} value={formatNumber(r.totalUnits, ctx.locale)} />
        <Stat label={t("losses.kpi.value")} value={money(r.totalValueMinor)} hint={r.variantsWithoutCost ? t("losses.kpi.without_cost", { n: r.variantsWithoutCost }) : t("losses.kpi.value_hint")} />
        <Stat label={t("losses.kpi.variants")} value={formatNumber(r.rows.length, ctx.locale)} />
      </div>
      {r.rows.length === 0 ? (
        <EmptyState title={t("losses.empty_title")} description={t("losses.empty_description")} />
      ) : (
        <Card data-testid="loss-report">
          <CardContent className="p-0">
            <DataList
              rows={r.rows}
              rowKey={(row) => row.variantId}
              rowProps={() => ({ "data-testid": "loss-row" })}
              columns={[
                { key: "variant", header: t("losses.columns.variant"), mobile: "title", cell: (row) => <><Link href={`/t/${tenant}/products/${row.productId}`} className="font-medium text-primary hover:underline">{row.productTitle}</Link><p className="text-xs font-normal text-muted-foreground">{row.variantTitle}{row.sku ? ` · ${row.sku}` : ""}</p></> },
                { key: "units", header: t("losses.columns.units"), mobile: "badge", align: "right", className: "tabular font-medium text-destructive", cell: (row) => `−${formatNumber(row.units, ctx.locale)}` },
                { key: "value", header: t("losses.columns.value"), align: "right", className: "tabular", cell: (row) => (row.costMissing ? <Badge variant="muted">{t("losses.no_cost")}</Badge> : money(row.valueMinor)) },
                { key: "events", header: t("losses.columns.events"), align: "right", className: "tabular", cell: (row) => row.events },
                { key: "locations", header: t("losses.columns.locations"), className: "text-sm", cell: (row) => row.locations.map((l) => (l === "*" ? t("losses.all_locations") : l)).join(", ") },
                { key: "last", header: t("losses.columns.last"), priority: 2, className: "whitespace-nowrap text-xs", cell: (row) => formatDateTime(row.lastDetectedAt, ctx.locale, ctx.tenant.timezone) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("losses.footnote")}</p>
    </>
  );
}
