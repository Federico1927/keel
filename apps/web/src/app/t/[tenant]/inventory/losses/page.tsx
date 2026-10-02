import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { unexplainedLosses } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Select, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
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
        <button type="submit" className="h-8 rounded-md border bg-secondary px-3 text-sm">{t("losses.apply")}</button>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("losses.columns.variant")}</TableHead>
                  <TableHead className="text-right">{t("losses.columns.units")}</TableHead>
                  <TableHead className="text-right">{t("losses.columns.value")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("losses.columns.events")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("losses.columns.locations")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("losses.columns.last")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rows.map((row) => (
                  <TableRow key={row.variantId} data-testid="loss-row">
                    <TableCell>
                      <Link href={`/t/${tenant}/products/${row.productId}`} className="font-medium text-primary hover:underline">{row.productTitle}</Link>
                      <p className="text-xs text-muted-foreground">{row.variantTitle}{row.sku ? ` · ${row.sku}` : ""}</p>
                    </TableCell>
                    <TableCell className="text-right tabular font-medium text-destructive">−{formatNumber(row.units, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{row.costMissing ? <Badge variant="muted">{t("losses.no_cost")}</Badge> : money(row.valueMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{row.events}</TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{row.locations.map((l) => (l === "*" ? t("losses.all_locations") : l)).join(", ")}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-xs lg:table-cell">{formatDateTime(row.lastDetectedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("losses.footnote")}</p>
    </>
  );
}
