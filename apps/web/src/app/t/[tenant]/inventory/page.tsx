import Link from "next/link";
import { ProductThumb } from "@/components/product-thumb";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { recentInventoryDrift } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, Button, CardTitle, DataList, EmptyState, Input, PageHeader, Pagination, Select, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { SyncInventoryButton } from "./sync-now";
import { listInventory, parseInventoryFilters } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";
import { AdjustStockDialog } from "@/components/adjust-stock-dialog";

import { withIntl } from "@/i18n/intl-scope";
async function InventoryPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("inventory");
  const tr = await getTranslations("stock_risk");
  const tc = await getTranslations("inventory_control");
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
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: lookback, target: ctx.settings.reorderTargetDays })} actions={<>{canSync && <SyncInventoryButton slug={tenant} />}<Link href={`/t/${tenant}/inventory/planning`} className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-muted" data-testid="planning-link">{t("planning_link")}</Link>{(["stock-takes", "markdowns", "losses"] as const).map((k) => <Link key={k} href={`${base}/${k}`} className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-muted" data-testid={`${k}-link`}>{tc(`links.${k}`)}</Link>)}</>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("kpi.units")} value={formatNumber(totalUnits, ctx.locale)} />
        <Stat label={t("kpi.value")} value={formatMoney(stockValue, ctx.tenant.currency, ctx.locale)} hint={t("kpi.value_hint")} />
        <Stat label={tr("critical")} value={counts.critical} href={link({ risk: "critical" })} className={counts.critical ? "border-destructive/40" : ""} />
        <Stat label={tr("warning")} value={counts.warning} href={link({ risk: "warning" })} className={counts.warning ? "border-warning/50" : ""} />
        <Stat label={t("kpi.reorder")} value={formatNumber(suggestedReorderTotal, ctx.locale)} hint={<Link href={`/t/${tenant}/purchasing/new`} className="text-primary underline">{t("create_po")}</Link>} />
      </div>
      <form className="mb-3 flex flex-wrap items-center gap-2" method="get">
        <Input type="search" enterKeyHint="search" size="sm" name="q" defaultValue={f.q ?? ""} placeholder={t("search_placeholder")} className="w-full sm:w-64" aria-label={t("search")} />
        {f.risk && <input type="hidden" name="risk" value={f.risk} />}
        <Select size="sm" name="location" defaultValue={f.location ?? ""} className="w-auto" aria-label={t("location")}>
          <option value="">{t("all_locations")}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
        <Select size="sm" name="lookback" defaultValue={String(lookback)} className="w-auto" aria-label={t("lookback")}>
          {[7, 14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>{t("lookback_days", { days: d })}</option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="secondary">{t("apply")}</Button>
        <div className="flex flex-wrap gap-1 sm:ml-auto">
          {(["critical", "warning", "ok", "no_sales"] as const).map((r) => (
            <Link key={r} href={link({ risk: f.risk === r ? undefined : r })} className={cn("rounded-full border px-3 py-1 text-xs pointer-coarse:py-2", f.risk === r ? "bg-primary text-primary-foreground" : "bg-card")}>
              {tr(r)} <span className="tabular font-normal">{counts[r]}</span>
            </Link>
          ))}
        </div>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.variantId}
              rowProps={() => ({ "data-testid": "inventory-row" })}
              columns={[
                {
                  key: "variant",
                  header: t("columns.variant"),
                  mobile: "title",
                  cell: (r) => (
                    <div className="flex items-center gap-2">
                      <ProductThumb src={r.imageUrl} alt={`${r.productTitle} ${r.variantTitle}`} size="xs" />
                      <div className="min-w-0">
                        <Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline max-md:after:absolute max-md:after:inset-0">{r.productTitle}</Link>
                        <p className="text-xs font-normal text-muted-foreground">{r.variantTitle} {r.sku ? `· ${r.sku}` : ""}</p>
                      </div>
                    </div>
                  ),
                },
                { key: "available", header: t("columns.available"), mobile: "badge", align: "right", className: "tabular font-medium", cell: (r) => r.available },
                { key: "incoming", header: t("columns.incoming"), align: "right", className: "tabular text-muted-foreground", cell: (r) => (r.incoming ? `+${r.incoming}` : "—") },
                { key: "sold", header: t("columns.sold"), align: "right", className: "tabular", cell: (r) => r.unitsSold },
                { key: "velocity", header: t("columns.velocity"), priority: 2, align: "right", className: "tabular", cell: (r) => r.velocityPerDay.toFixed(2) },
                { key: "cover", header: t("columns.cover"), label: "", cell: (r) => <RiskBadge risk={r.risk} days={r.daysOfCover} /> },
                { key: "reorder", header: t("columns.reorder"), align: "right", className: "tabular", cell: (r) => r.suggestedReorder || "—" },
                ...(canSync ? [{ key: "adjust", header: <span className="sr-only">{tc("adjust.button")}</span>, mobile: "action" as const, headClassName: "w-10", className: "md:text-right max-md:basis-auto max-md:pt-0", cell: (r: (typeof rows)[number]) => <AdjustStockDialog compact slug={tenant} variants={[{ id: r.variantId, label: `${r.productTitle} · ${r.variantTitle}${r.sku ? ` · ${r.sku}` : ""}`, levels: Object.fromEntries(r.byLocation.map((l) => [l.locationId, l.available])) }]} locations={locations.map((l) => ({ id: l.id, name: l.name }))} defaultLocationId={f.location ?? locations[0]?.id} /> }] : []),
              ]}
            />
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
            <DataList
              rows={drift}
              rowKey={(r) => r.d.id}
              rowProps={(r) => ({ "data-testid": "drift-row", "data-kind": r.d.kind })}
              columns={[
                { key: "seen", header: t("drift_columns.seen"), mobile: "meta", label: "", className: "whitespace-nowrap text-xs", cell: (r) => <>{formatDateTime(r.d.lastSeenAt, ctx.locale, ctx.tenant.timezone)}{r.d.occurrences > 1 && <span className="ml-1 text-muted-foreground">{t("drift_times", { n: r.d.occurrences })}</span>}</> },
                { key: "variant", header: t("drift_columns.variant"), mobile: "title", cell: (r) => <><Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.productTitle}</Link><p className="text-xs font-normal text-muted-foreground">{r.variantTitle} {r.sku ? `· ${r.sku}` : ""}</p></> },
                { key: "location", header: t("drift_columns.location"), className: "text-sm", cell: (r) => r.locationName ?? t("drift_all_locations") },
                { key: "kind", header: t("drift_columns.kind"), mobile: "badge", cell: (r) => <Badge variant={r.d.kind === "unexplained" ? "warning" : r.d.kind === "negative" ? "destructive" : "muted"}>{t(`drift_kind.${r.d.kind}`)}</Badge> },
                { key: "expected", header: t("drift_columns.expected"), align: "right", className: "tabular", cell: (r) => formatNumber(r.d.expected, ctx.locale) },
                { key: "observed", header: t("drift_columns.observed"), align: "right", className: "tabular font-medium", cell: (r) => formatNumber(r.d.observed, ctx.locale) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(InventoryPage, "app/t/[tenant]/inventory/page.tsx");
