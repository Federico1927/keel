import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { and, eq, schema } from "@hullwise/db";
import { bundleReport, cashFlowPlan, listDemandEvents, materialRequirements, productForecast, replenishmentPlan, revenueTargetPlan, stockAnalysisReport, transferPlan, type ServiceContext } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, Select, Stat, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { ChartFullscreen } from "@/components/mobile/chart-fullscreen";
import { DesktopNotice } from "@/components/mobile/desktop-notice";
import { WideTable } from "@/components/mobile/wide-table";
import { BundleForm, CashChart, DeleteComponentButton, DeleteEventButton, DemandEventForm, ForecastChart, OverrideCell, ReplenishmentTable, TransferButton } from "./controls";

const TABS = ["replenishment", "forecast", "analysis", "transfers", "cashflow", "target", "bundles"] as const;
type Tab = (typeof TABS)[number];

export default async function PlanningPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; all?: string; product?: string; cell?: string; target?: string; months?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("planning");
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "replenishment";
  const pt = { id: ctx.tenant.id, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, settings: ctx.settings };
  const s = (tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const date = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`), ctx.locale, ctx.tenant.timezone);
  const canWrite = canWritePage(ctx.role, "inventory");
  const canBuy = canWritePage(ctx.role, "purchasing");
  const base = `/t/${tenant}/inventory/planning`;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, ...patch })) if (v) u.set(k, v);
    return `${base}?${u}`;
  };

  return (
    <>
      <Link href={`/t/${tenant}/inventory`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { level: formatPercent(ctx.settings.serviceLevelBps / 10000, ctx.locale), review: ctx.settings.reviewDays })} />
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-md bg-muted p-1 text-sm md:flex-wrap">
        {TABS.map((k) => (
          <Link key={k} href={href({ tab: k })} className={cn("shrink-0 whitespace-nowrap rounded-sm px-3 py-1.5 text-center pointer-coarse:py-2.5 md:flex-1", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`planning-tab-${k}`}>
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </div>

      {tab === "replenishment" && (await (async () => {
        const rows = await ctx.run((tx) => replenishmentPlan(s(tx), pt, { onlyToOrder: sp.all !== "1" }));
        const today = Date.now();
        const urgentDays = (r: (typeof rows)[number]) => (r.stockoutDate ? (new Date(r.stockoutDate).getTime() - today) / 864e5 : Infinity);
        const urgent = rows.filter((r) => r.shouldOrder && urgentDays(r) <= r.leadTimeDays);
        const totalCost = rows.filter((r) => r.shouldOrder && r.inDraft === 0).reduce((n, r) => n + (r.costMinor ?? 0), 0);
        const suppliers = new Set(rows.filter((r) => r.shouldOrder && r.supplierId).map((r) => r.supplierId)).size;
        return (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t("replenishment.kpi.to_order")} value={formatNumber(rows.filter((r) => r.shouldOrder).length, ctx.locale)} />
              <Stat label={t("replenishment.kpi.urgent")} value={formatNumber(urgent.length, ctx.locale)} hint={t("replenishment.kpi.urgent_hint")} className={urgent.length ? "border-destructive/40" : ""} />
              <Stat label={t("replenishment.kpi.cost")} value={money(totalCost)} />
              <Stat label={t("replenishment.kpi.suppliers")} value={suppliers} />
            </div>
            <div className="mb-3 flex gap-3 text-sm">
              <Link href={href({ all: undefined })} className={sp.all !== "1" ? "font-medium" : "text-muted-foreground hover:underline"}>{t("replenishment.only_to_order")}</Link>
              <Link href={href({ all: "1" })} className={sp.all === "1" ? "font-medium" : "text-muted-foreground hover:underline"}>{t("replenishment.all_variants")}</Link>
            </div>
            {rows.length === 0 ? (
              <EmptyState title={t("replenishment.empty_title")} description={t("replenishment.empty_description")} />
            ) : canBuy ? (
              <ReplenishmentTable
                slug={tenant}
                rows={rows.slice(0, 300).map((r) => ({
                  variantId: r.variantId,
                  productId: r.productId,
                  label: r.label,
                  sku: r.sku,
                  supplier: r.supplierName,
                  available: r.available,
                  incoming: r.incoming,
                  backordered: r.backordered,
                  daily: formatNumber(r.dailyMean, ctx.locale, { maximumFractionDigits: 2 }),
                  cover: r.daysOfCover === null ? "" : t("replenishment.cover_days", { n: Math.round(r.daysOfCover), lead: r.leadTimeDays }),
                  stockout: r.stockoutDate ? date(r.stockoutDate) : null,
                  urgent: r.shouldOrder && urgentDays(r) <= r.leadTimeDays,
                  safetyStock: r.safetyStock,
                  reorderPoint: r.reorderPoint,
                  quantity: r.quantity,
                  constraint: [r.moq ? t("replenishment.moq", { n: r.moq }) : null, r.multiple && r.multiple > 1 ? t("replenishment.multiple", { n: r.multiple }) : null].filter(Boolean).join(" · ") || null,
                  cost: r.costMinor !== null ? money(r.costMinor) : "—",
                  inDraft: r.inDraft,
                  shouldOrder: r.shouldOrder,
                }))}
              />
            ) : (
              <Card>
                <CardContent className="p-0">
                  <DataList
                    rows={rows.slice(0, 300)}
                    rowKey={(r) => r.variantId}
                    rowProps={() => ({ "data-testid": "replenishment-row" })}
                    columns={[
                      { key: "variant", header: t("replenishment.columns.variant"), mobile: "title", cell: (r) => r.label },
                      { key: "order", header: t("replenishment.columns.order"), mobile: "badge", align: "right", className: "tabular", cell: (r) => (r.shouldOrder ? r.quantity : "—") },
                      { key: "position", header: t("replenishment.columns.position"), align: "right", className: "tabular", cell: (r) => r.position },
                      { key: "stockout", header: t("replenishment.columns.stockout"), cell: (r) => (r.stockoutDate ? date(r.stockoutDate) : "—") },
                    ]}
                  />
                </CardContent>
              </Card>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("replenishment.method")}</p>
          </>
        );
      })())}

      {tab === "forecast" && (await (async () => {
        const { products, types, events } = await ctx.run(async (tx) => ({
          products: await tx.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.status, "active"))).orderBy(schema.products.title),
          types: [...new Set((await tx.select({ t: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenant.id))).map((r) => r.t).filter((x): x is string => Boolean(x)))].sort(),
          events: await listDemandEvents(s(tx)),
        }));
        const productId = products.find((p) => p.id === sp.product)?.id ?? products[0]?.id;
        const fc = productId ? await ctx.run((tx) => productForecast(s(tx), pt, productId)) : null;
        const months = fc?.variants[0]?.forecast.map((f) => f.month).slice(0, 6) ?? [];
        const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
        const defaultMonth = next.toISOString().slice(0, 7);
        const wapes = fc?.variants.filter((v) => v.wape !== null).map((v) => v.wape!) ?? [];
        const histTotal = fc?.series.filter((x) => x.history !== null).reduce((n, x) => n + (x.history ?? 0), 0) ?? 0;
        return (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-4">
              <form method="get" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="tab" value="forecast" />
                <Select size="sm" name="product" defaultValue={productId} className="max-w-xs" aria-label={t("forecast.product")}>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </Select>
                <button type="submit" className="h-9 rounded-md border bg-secondary px-3 text-sm">{t("apply")}</button>
              </form>
              {fc && (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{products.find((p) => p.id === productId)?.title}</CardTitle>
                      <CardDescription>{t("forecast.chart_hint", { history: formatNumber(histTotal, ctx.locale) })}{wapes.length ? ` · ${t("forecast.accuracy", { wape: formatPercent(wapes.reduce((a, b) => a + b, 0) / wapes.length, ctx.locale) })}` : ""}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ChartFullscreen title={products.find((p) => p.id === productId)?.title ?? t("tabs.forecast")}><ForecastChart data={fc.series} locale={ctx.locale} labels={{ history: t("forecast.history"), forecast: t("forecast.forecast") }} /></ChartFullscreen>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{t("forecast.by_variant")}</CardTitle>
                      <CardDescription>{canWrite ? t("forecast.override_hint") : ""}</CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      {canWrite && <DesktopNotice className="mx-4">{t("forecast.override_hint")}</DesktopNotice>}
                      <WideTable label={t("forecast.by_variant")} stickyFirst data-testid="forecast-grid">
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("forecast.variant")}</TableHead>
                            {months.map((m) => <TableHead key={m} className="text-right">{formatDate(new Date(`${m}-15T12:00:00Z`), ctx.locale, "UTC", { month: "short", year: "2-digit" })}</TableHead>)}
                            <TableHead className="text-right">{t("forecast.wape")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {fc.variants.map((v) => (
                            <TableRow key={v.variantId}>
                              <TableCell className="min-w-32">{v.label}<span className="block text-xs text-muted-foreground">{v.sku}</span></TableCell>
                              {v.forecast.slice(0, 6).map((p) => (
                                <TableCell key={p.month} className="text-right" title={p.uplift ? t("forecast.uplift", { pct: formatPercent(p.uplift, ctx.locale) }) : undefined}>
                                  {canWrite ? <OverrideCell slug={tenant} variantId={v.variantId} month={p.month} units={p.units} overridden={p.overridden} /> : <span className="tabular">{p.units}</span>}
                                  {p.uplift !== 0 && <span className="ml-0.5 text-xs text-warning">↑</span>}
                                </TableCell>
                              ))}
                              <TableCell className="text-right text-xs text-muted-foreground">{v.wape === null ? "—" : formatPercent(v.wape, ctx.locale)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </WideTable>
                    </CardContent>
                  </Card>
                </>
              )}
              <p className="text-xs text-muted-foreground">{t("forecast.method")}</p>
            </div>
            <Card className="h-fit">
              <CardHeader>
                <CardTitle className="text-base">{t("events.title")}</CardTitle>
                <CardDescription>{t("events.hint")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <ul className="space-y-1" data-testid="demand-events">
                  {events.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-medium">{e.name}</span>{" "}
                        <span className="text-xs text-muted-foreground">{e.month} · {e.upliftBps > 0 ? "+" : ""}{formatPercent(e.upliftBps / 10000, ctx.locale)} · {e.scope === "all" ? t("events.scopes.all") : e.scopeValue}</span>
                      </span>
                      {canWrite && <DeleteEventButton slug={tenant} id={e.id} />}
                    </li>
                  ))}
                  {events.length === 0 && <li className="text-muted-foreground">{t("events.empty")}</li>}
                </ul>
                {canWrite && <div className="border-t pt-3"><DemandEventForm slug={tenant} productTypes={types} defaultMonth={defaultMonth} /></div>}
              </CardContent>
            </Card>
          </div>
        );
      })())}

      {tab === "analysis" && (await (async () => {
        const r = await ctx.run((tx) => stockAnalysisReport(s(tx), pt));
        const cell = sp.cell && /^[ABC][XYZ]$/.test(sp.cell) ? sp.cell : null;
        const list = (cell ? r.rows.filter((x) => `${x.abc}${x.xyz}` === cell) : r.rows.filter((x) => x.slowMover || x.excessUnits > 0)).sort((a, b) => b.stockValueMinor - a.stockValueMinor).slice(0, 100);
        return (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t("analysis.kpi.value")} value={money(r.totalValueMinor)} />
              <Stat label={t("analysis.kpi.excess")} value={money(r.excessValueMinor)} hint={t("analysis.kpi.excess_hint", { days: ctx.settings.excessCoverDays })} />
              <Stat label={t("analysis.kpi.slow")} value={money(r.slowValueMinor)} hint={t("analysis.kpi.slow_hint", { days: ctx.settings.slowCoverDays })} />
              <Stat label={t("analysis.kpi.variants")} value={formatNumber(r.rows.length, ctx.locale)} />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
              <Card className="h-fit">
                <CardHeader>
                  <CardTitle className="text-base">{t("analysis.matrix")}</CardTitle>
                  <CardDescription>{t("analysis.matrix_hint")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-center text-xs" data-testid="abc-xyz">
                    <thead>
                      <tr><th />{["X", "Y", "Z"].map((x) => <th key={x} className="p-1 font-medium" title={t(`analysis.xyz.${x}`)}>{x}</th>)}</tr>
                    </thead>
                    <tbody>
                      {["A", "B", "C"].map((a) => (
                        <tr key={a}>
                          <th className="p-1 font-medium" title={t(`analysis.abc.${a}`)}>{a}</th>
                          {["X", "Y", "Z"].map((x) => {
                            const k = `${a}${x}`;
                            const m = r.matrix[k];
                            return (
                              <td key={k} className="p-0.5">
                                <Link href={href({ cell: cell === k ? undefined : k })} className={cn("block rounded border p-2 hover:bg-muted", cell === k && "border-primary bg-primary/10")}>
                                  <span className="block text-base font-semibold tabular">{m?.count ?? 0}</span>
                                  <span className="text-muted-foreground">{money(m?.valueMinor ?? 0)}</span>
                                </Link>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-muted-foreground">{t("analysis.legend")}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{cell ? t("analysis.cell_title", { cell }) : t("analysis.attention")}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {list.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">{t("analysis.empty")}</p> : (
                    <DataList
                      rows={list}
                      rowKey={(x) => x.id}
                      rowProps={() => ({ "data-testid": "analysis-row" })}
                      columns={[
                        { key: "variant", header: t("analysis.columns.variant"), mobile: "title", cell: (x) => <><Link href={`/t/${tenant}/products/${x.productId}`} className="hover:underline">{x.label}</Link><span className="block text-xs font-normal text-muted-foreground">{x.sku}</span></> },
                        { key: "class", header: t("analysis.columns.class"), mobile: "badge", cell: (x) => <><Badge variant="outline">{x.abc}{x.xyz}</Badge>{x.slowMover && <Badge variant="warning" className="ml-1">{t("analysis.slow")}</Badge>}</> },
                        { key: "on_hand", header: t("analysis.columns.on_hand"), align: "right", className: "tabular", cell: (x) => x.onHand },
                        { key: "value", header: t("analysis.columns.value"), align: "right", className: "tabular", cell: (x) => money(x.stockValueMinor) },
                        { key: "cover", header: t("analysis.columns.cover"), align: "right", className: "tabular", cell: (x) => (x.coverDays === null ? "—" : x.coverDays === Infinity ? "∞" : t("analysis.days", { n: x.coverDays })) },
                        { key: "turnover", header: t("analysis.columns.turnover"), align: "right", priority: 2, className: "tabular", cell: (x) => x.turnover ?? "—" },
                        { key: "excess", header: t("analysis.columns.excess"), align: "right", className: "tabular", cell: (x) => x.excessUnits || "—" },
                      ]}
                    />
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        );
      })())}

      {tab === "transfers" && (await (async () => {
        const rows = await ctx.run((tx) => transferPlan(s(tx), pt));
        return rows.length === 0 ? (
          <EmptyState title={t("transfers.empty_title")} description={t("transfers.empty_description")} />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">{t("transfers.hint", { short: ctx.settings.transferShortDays, surplus: ctx.settings.transferSurplusDays })}</p>
            <Card>
              <CardContent className="p-0">
                <DataList
                  rows={rows.slice(0, 200)}
                  rowKey={(r, i) => `${r.variantId}-${i}`}
                  rowProps={() => ({ "data-testid": "transfer-row" })}
                  columns={[
                    { key: "variant", header: t("transfers.columns.variant"), mobile: "title", cell: (r) => <>{r.label}<span className="block text-xs font-normal text-muted-foreground">{r.sku}</span></> },
                    { key: "units", header: t("transfers.columns.units"), mobile: "badge", align: "right", className: "tabular", cell: (r) => r.units },
                    { key: "from", header: t("transfers.columns.from"), cell: (r) => r.from.name },
                    { key: "to", header: t("transfers.columns.to"), cell: (r) => r.to.name },
                    ...(canWrite ? [{ key: "apply", header: <span className="sr-only">{t("transfers.columns.units")}</span>, mobile: "action" as const, align: "right" as const, cell: (r: (typeof rows)[number]) => <TransferButton slug={tenant} input={{ variantId: r.variantId, fromLocationId: r.from.id, toLocationId: r.to.id, units: r.units }} /> }] : []),
                  ]}
                />
              </CardContent>
            </Card>
          </>
        );
      })())}

      {tab === "cashflow" && (await (async () => {
        const r = await ctx.run((tx) => cashFlowPlan(s(tx), pt));
        return (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Stat label={t("cashflow.committed")} value={money(r.committedMinor)} hint={t("cashflow.committed_hint")} />
              <Stat label={t("cashflow.planned")} value={money(r.plannedMinor)} hint={t("cashflow.planned_hint")} />
              <Stat label={t("cashflow.total")} value={money(r.committedMinor + r.plannedMinor)} />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
              <Card>
                <CardHeader><CardTitle className="text-base">{t("cashflow.by_month")}</CardTitle></CardHeader>
                <CardContent>
                  <ChartFullscreen title={t("cashflow.by_month")}><CashChart data={r.byMonth} locale={ctx.locale} currency={ctx.tenant.currency} labels={{ committed: t("cashflow.committed"), planned: t("cashflow.planned") }} /></ChartFullscreen>
                  <WideTable label={t("cashflow.by_month")} stickyFirst>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("cashflow.month")}</TableHead>
                        <TableHead className="text-right">{t("cashflow.committed")}</TableHead>
                        <TableHead className="text-right">{t("cashflow.planned")}</TableHead>
                        <TableHead className="text-right">{t("cashflow.cumulative")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.byMonth.map((m) => (
                        <TableRow key={m.month} data-testid="cash-month">
                          <TableCell>{m.month}</TableCell>
                          <TableCell className="text-right tabular">{money(m.committedMinor)}</TableCell>
                          <TableCell className="text-right tabular">{money(m.plannedMinor)}</TableCell>
                          <TableCell className="text-right tabular font-medium">{money(m.cumulativeMinor)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </WideTable>
                </CardContent>
              </Card>
              <Card className="h-fit">
                <CardHeader><CardTitle className="text-base">{t("cashflow.payments")}</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {r.items.slice(0, 40).map((i, k) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span>
                        {date(i.date)} · {i.ref.startsWith("plan:") ? t("cashflow.plan_ref", { supplier: i.supplierName ?? "—" }) : i.ref}
                        <span className="block text-xs text-muted-foreground">{t(`cashflow.kinds.${i.kind}`)}{i.supplierName && !i.ref.startsWith("plan:") ? ` · ${i.supplierName}` : ""}{i.planned ? ` · ${t("cashflow.planned")}` : ""}</span>
                      </span>
                      <span className="tabular">{money(i.amountMinor)}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t("cashflow.method")}</p>
          </>
        );
      })())}

      {tab === "target" && (await (async () => {
        const months = Math.min(12, Math.max(1, Number(sp.months) || 3));
        const target = Math.max(0, Math.round(Number(sp.target) * 100)) || null;
        const r = target ? await ctx.run((tx) => revenueTargetPlan(s(tx), pt, target, months)) : null;
        return (
          <>
            <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="tab" value="target" />
              <label className="space-y-1 text-sm">
                <span className="block text-xs text-muted-foreground">{t("target.revenue")}</span>
                <input name="target" type="number" min={1} step="1" defaultValue={sp.target ?? ""} required className="h-9 w-40 rounded-md border border-input bg-card px-2" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="block text-xs text-muted-foreground">{t("target.months")}</span>
                <Select size="sm" name="months" defaultValue={String(months)} className="w-auto">
                  {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </label>
              <button type="submit" className="h-9 rounded-md border bg-secondary px-3 text-sm" data-testid="target-submit">{t("target.compute")}</button>
            </form>
            {!r ? (
              <EmptyState title={t("target.empty_title")} description={t("target.empty_description")} />
            ) : (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <Stat label={t("target.forecast_revenue")} value={money(r.forecastRevenueMinor)} hint={t("target.forecast_hint", { months })} />
                  <Stat label={t("target.target")} value={money(target!)} hint={r.forecastRevenueMinor ? t("target.vs_forecast", { pct: formatPercent(target! / r.forecastRevenueMinor - 1, ctx.locale) }) : undefined} />
                  <Stat label={t("target.gap_cost")} value={money(r.gapCostMinor)} hint={t("target.gap_hint")} />
                </div>
                <Card>
                  <CardContent className="p-0">
                    <DataList
                      rows={r.rows.slice(0, 100)}
                      rowKey={(x) => x.variantId}
                      rowProps={() => ({ "data-testid": "target-row" })}
                      columns={[
                        { key: "variant", header: t("target.columns.variant"), mobile: "title", cell: (x) => <>{x.label}<span className="block text-xs font-normal text-muted-foreground">{x.sku}</span></> },
                        { key: "forecast", header: t("target.columns.forecast"), align: "right", className: "tabular", cell: (x) => x.forecastUnits },
                        { key: "planned", header: t("target.columns.planned"), align: "right", className: "tabular", cell: (x) => x.plannedUnits },
                        { key: "stock", header: t("target.columns.stock"), align: "right", className: "tabular", cell: (x) => x.stockUnits },
                        { key: "gap", header: t("target.columns.gap"), align: "right", className: "tabular", cell: (x) => <span className={cn(x.gapUnits > 0 && "font-medium text-destructive")}>{x.gapUnits || "—"}</span> },
                        { key: "gap_cost", header: t("target.columns.gap_cost"), align: "right", className: "tabular", cell: (x) => (x.gapCostMinor ? money(x.gapCostMinor) : "—") },
                      ]}
                    />
                  </CardContent>
                </Card>
              </>
            )}
          </>
        );
      })())}

      {tab === "bundles" && (await (async () => {
        const { bundles, mrp, variants } = await ctx.run(async (tx) => ({
          bundles: await bundleReport(s(tx)),
          mrp: await materialRequirements(s(tx), pt, 3),
          variants: canWrite ? (await tx.select({ id: schema.productVariants.id, title: schema.productVariants.title, product: schema.products.title, sku: schema.productVariants.sku }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, ctx.tenant.id)).orderBy(schema.products.title, schema.productVariants.title)).map((v) => ({ id: v.id, label: `${v.product} ${v.title}${v.sku ? ` (${v.sku})` : ""}` })) : [],
        }));
        return (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-4">
              {bundles.length === 0 && <EmptyState title={t("bundles.empty_title")} description={t("bundles.empty_description")} />}
              {bundles.map((b) => (
                <Card key={b.parentVariantId} data-testid="bundle-card">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{b.label}</CardTitle>
                      <Badge variant={b.kind === "bom" ? "info" : "outline"}>{t(`bundles.kinds.${b.kind}`)}</Badge>
                    </div>
                    <CardDescription>{b.kind === "bundle" ? t("bundles.available", { n: b.available }) : t("bundles.buildable", { n: b.available })}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    {b.components.map((c) => (
                      <div key={c.variantId} className="flex items-center justify-between gap-2">
                        <span>{c.quantity} × {c.label}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          {t("bundles.in_stock", { n: c.available })}
                          {canWrite && <DeleteComponentButton slug={tenant} parentVariantId={b.parentVariantId} componentVariantId={c.variantId} />}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
              {mrp.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{t("bundles.mrp_title")}</CardTitle>
                    <CardDescription>{t("bundles.mrp_hint")}</CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <DataList
                      rows={mrp}
                      rowKey={(m) => m.variantId}
                      columns={[
                        { key: "component", header: t("bundles.component"), mobile: "title", cell: (m) => m.label },
                        { key: "required", header: t("bundles.required"), align: "right", className: "tabular", cell: (m) => m.requiredUnits },
                        { key: "stock", header: t("bundles.stock"), align: "right", className: "tabular", cell: (m) => m.availableUnits },
                        { key: "shortfall", header: t("bundles.shortfall"), align: "right", className: "tabular", cell: (m) => <span className={cn(m.shortfall > 0 && "font-medium text-destructive")}>{m.shortfall || "—"}</span> },
                      ]}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
            {canWrite && (
              <Card className="h-fit">
                <CardHeader>
                  <CardTitle className="text-base">{t("bundles.add_title")}</CardTitle>
                  <CardDescription>{t("bundles.add_hint")}</CardDescription>
                </CardHeader>
                <CardContent><BundleForm slug={tenant} variants={variants} /></CardContent>
              </Card>
            )}
          </div>
        );
      })())}
    </>
  );
}
