import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { recentInventoryDrift } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Pagination, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { SyncInventoryButton } from "./sync-now";
import { listInventory, parseInventoryFilters } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";

export default async function InventoryPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("inventory");
  const tr = await getTranslations("stock_risk");
  const f = parseInventoryFilters(sp);
  const { rows, total, page, pageSize, counts, locations, totalUnits, stockValue, suggestedReorderTotal } = await listInventory(ctx, f);
  const drift = await ctx.run((tx) => recentInventoryDrift({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { limit: 8 }));
  const canSync = canWritePage(ctx.role, "inventory");
  const base = `/t/${tenant}/inventory`;
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: f.q, risk: f.risk, location: f.location, lookback: f.lookback ? String(f.lookback) : undefined, ...patch })) if (v) u.set(k, v);
    return `${base}${u.size ? `?${u}` : ""}`;
  };
  const lookback = f.lookback ?? ctx.settings.salesVelocityLookbackDays;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: lookback, target: ctx.settings.reorderTargetDays })} actions={<>{canSync && <SyncInventoryButton slug={tenant} />}<Link href={`/t/${tenant}/inventory/planning`} className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-muted" data-testid="planning-link">{t("planning_link")}</Link></>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("kpi.units")} value={formatNumber(totalUnits, ctx.locale)} />
        <Stat label={t("kpi.value")} value={formatMoney(stockValue, ctx.tenant.currency, ctx.locale)} hint={t("kpi.value_hint")} />
        <Stat label={tr("critical")} value={counts.critical} href={link({ risk: "critical" })} className={counts.critical ? "border-destructive/40" : ""} />
        <Stat label={tr("warning")} value={counts.warning} href={link({ risk: "warning" })} className={counts.warning ? "border-warning/50" : ""} />
        <Stat label={t("kpi.reorder")} value={formatNumber(suggestedReorderTotal, ctx.locale)} hint={<Link href={`/t/${tenant}/purchasing/new`} className="text-primary underline">{t("create_po")}</Link>} />
      </div>
      <form className="mb-3 flex flex-wrap items-center gap-2" method="get">
        <input name="q" defaultValue={f.q ?? ""} placeholder={t("search_placeholder")} className="h-9 w-64 rounded-md border border-input bg-card px-3 text-sm" aria-label={t("search")} />
        {f.risk && <input type="hidden" name="risk" value={f.risk} />}
        <select name="location" defaultValue={f.location ?? ""} className="h-9 rounded-md border border-input bg-card px-2 text-sm" aria-label={t("location")}>
          <option value="">{t("all_locations")}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <select name="lookback" defaultValue={String(lookback)} className="h-9 rounded-md border border-input bg-card px-2 text-sm" aria-label={t("lookback")}>
          {[7, 14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>{t("lookback_days", { days: d })}</option>
          ))}
        </select>
        <button type="submit" className="h-9 rounded-md border bg-secondary px-3 text-sm">{t("apply")}</button>
        <div className="ml-auto flex gap-1">
          {(["critical", "warning", "ok", "no_sales"] as const).map((r) => (
            <Link key={r} href={link({ risk: f.risk === r ? undefined : r })} className={cn("rounded-full border px-3 py-1 text-xs", f.risk === r ? "bg-primary text-primary-foreground" : "bg-card")}>
              {tr(r)} <span className="tabular opacity-70">{counts[r]}</span>
            </Link>
          ))}
        </div>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.variant")}</TableHead>
                  <TableHead className="text-right">{t("columns.available")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.incoming")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.sold")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.velocity")}</TableHead>
                  <TableHead>{t("columns.cover")}</TableHead>
                  <TableHead className="text-right">{t("columns.reorder")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.variantId}>
                    <TableCell>
                      <Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">
                        {r.productTitle}
                      </Link>
                      <p className="text-xs text-muted-foreground">{r.variantTitle} {r.sku ? `· ${r.sku}` : ""}</p>
                    </TableCell>
                    <TableCell className="text-right tabular font-medium">{r.available}</TableCell>
                    <TableCell className="hidden text-right tabular text-muted-foreground md:table-cell">{r.incoming ? `+${r.incoming}` : "—"}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.unitsSold}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{r.velocityPerDay.toFixed(2)}</TableCell>
                    <TableCell><RiskBadge risk={r.risk} days={r.daysOfCover} /></TableCell>
                    <TableCell className="text-right tabular">{r.suggestedReorder || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={(p) => link({ page: String(p) })} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
      <Card className="mt-6" data-testid="inventory-drift">
        <CardHeader>
          <CardTitle className="text-base">{t("drift_title")}</CardTitle>
          <CardDescription>{t("drift_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {drift.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("drift_empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("drift_columns.seen")}</TableHead>
                  <TableHead>{t("drift_columns.variant")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("drift_columns.location")}</TableHead>
                  <TableHead>{t("drift_columns.kind")}</TableHead>
                  <TableHead className="text-right">{t("drift_columns.expected")}</TableHead>
                  <TableHead className="text-right">{t("drift_columns.observed")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drift.map((r) => (
                  <TableRow key={r.d.id} data-testid="drift-row" data-kind={r.d.kind}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.d.lastSeenAt, ctx.locale, ctx.tenant.timezone)}{r.d.occurrences > 1 && <span className="ml-1 text-muted-foreground">{t("drift_times", { n: r.d.occurrences })}</span>}</TableCell>
                    <TableCell>
                      <Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.productTitle}</Link>
                      <p className="text-xs text-muted-foreground">{r.variantTitle} {r.sku ? `· ${r.sku}` : ""}</p>
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{r.locationName ?? t("drift_all_locations")}</TableCell>
                    <TableCell><Badge variant={r.d.kind === "unexplained" ? "warning" : r.d.kind === "negative" ? "destructive" : "muted"}>{t(`drift_kind.${r.d.kind}`)}</Badge></TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.d.expected, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular font-medium">{formatNumber(r.d.observed, ctx.locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
