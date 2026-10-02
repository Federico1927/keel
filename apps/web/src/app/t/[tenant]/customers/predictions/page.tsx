import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, type ChurnRisk, type SegmentGroup } from "@hullwise/core";
import { predictionOverview, type PredictionListRow } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { encodeRulesParam } from "@/server/queries/crm";
import { CustomerTabs } from "../customer-tabs";
import { ChurnBadge } from "../churn-badge";
import { RecomputeButton } from "./recompute-button";

import { withIntl } from "@/i18n/intl-scope";
const riskRules = (risk: ChurnRisk): SegmentGroup => ({ match: "all", conditions: [{ field: "churn_risk", op: "in", value: [risk] }] });
/** Valuable customers drifting away: the win-back segment the "slipping" list previews. */
const slippingRules: SegmentGroup = { match: "all", conditions: [{ field: "churn_risk", op: "in", value: ["medium", "high"] }, { field: "orders_count", op: "gte", value: 2 }] };

async function PredictionsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "customers");
  const t = await getTranslations("predictions");
  const tc = await getTranslations("customers");
  const o = await ctx.run((tx) => predictionOverview({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const num = (n: number, digits = 0) => formatNumber(n, ctx.locale, { maximumFractionDigits: digits });
  const canSegment = canWritePage(ctx.role, "segments");
  const segmentHref = (rules: SegmentGroup) => `/t/${tenant}/segments/new?rules=${encodeRulesParam(rules)}`;
  const base = `/t/${tenant}/customers`;
  const total = o.byRisk.reduce((s, b) => s + b.customers, 0);
  const cal = o.model?.calibration ?? null;

  const list = (title: string, description: string, rows: PredictionListRow[], testId: string, segment?: SegmentGroup) => (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {segment && canSegment && rows.length > 0 && (
          <Link href={segmentHref(segment)} className="shrink-0 text-sm text-primary hover:underline">{t("create_segment")}</Link>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{t("list_empty")}</p>
        ) : (
          <DataList
            rows={rows}
            rowKey={(r) => r.customerId}
            columns={[
              { key: "customer", header: tc("columns.customer"), mobile: "title", cell: (r) => <><Link href={`${base}/${r.customerId}`} className="font-medium hover:underline">{r.name}</Link><div className="text-xs font-normal text-muted-foreground">{t("orders_n", { n: r.ordersCount })} · <ChurnBadge risk={r.churnRisk} /></div></> },
              { key: "predicted", header: t("columns.predicted_value"), mobile: "badge", align: "right", className: "tabular max-md:font-semibold", cell: (r) => money(r.predictedValue365Minor) },
              { key: "spent", header: tc("columns.total_spent"), align: "right", className: "tabular", cell: (r) => money(r.totalSpentMinor) },
              { key: "alive", header: t("columns.p_alive"), align: "right", className: "tabular", cell: (r) => formatPercent(r.pAlive, ctx.locale, 0) },
              { key: "next", header: t("columns.next_order"), cell: (r) => (r.nextOrderAt ? formatDate(r.nextOrderAt, ctx.locale, ctx.tenant.timezone) : "—") },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={tc("title")} description={t("description")} actions={canSegment ? <RecomputeButton slug={tenant} /> : undefined} />
      <CustomerTabs tenant={tenant} active="predictions" />
      {!o.model ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : o.model.status !== "ok" ? (
        <Alert><AlertDescription>{t("insufficient_data", { n: o.model.customers })}</AlertDescription></Alert>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t("kpi.expected_orders_90")} value={num(o.expectedOrders90)} hint={t("kpi.from_existing")} />
            <Stat label={t("kpi.expected_orders_365")} value={num(o.expectedOrders365)} hint={t("kpi.from_existing")} />
            <Stat label={t("kpi.predicted_value")} value={money(o.predictedValue365Minor)} hint={t("kpi.next_12_months")} />
            <Stat label={t("kpi.at_risk")} value={num(o.byRisk.find((b) => b.risk === "high")?.customers ?? 0)} hint={t("kpi.at_risk_hint", { pct: formatPercent(total ? (o.byRisk.find((b) => b.risk === "high")?.customers ?? 0) / total : 0, ctx.locale, 0) })} href={`${base}?churn=high&sort=total_spent`} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("risk_title")}</CardTitle>
                <CardDescription>{t("risk_description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <DataList
                  rows={o.byRisk}
                  rowKey={(b) => b.risk}
                  rowProps={() => ({ "data-testid": "risk-row" })}
                  columns={[
                    { key: "risk", header: t("columns.risk"), mobile: "title", cell: (b) => <Link href={`${base}?churn=${b.risk}`} className="hover:underline"><ChurnBadge risk={b.risk} /></Link> },
                    { key: "customers", header: tc("columns.customers"), mobile: "badge", align: "right", className: "tabular", cell: (b) => num(b.customers) },
                    { key: "historical", header: t("columns.historical"), align: "right", className: "tabular", cell: (b) => money(b.historicalMinor) },
                    { key: "predicted", header: t("columns.predicted_value"), align: "right", className: "tabular", cell: (b) => money(b.predictedMinor) },
                    ...(canSegment ? [{ key: "segment", header: <span className="sr-only">{t("segment_short")}</span>, mobile: "action" as const, align: "right" as const, cell: (b: (typeof o.byRisk)[number]) => <Link href={segmentHref(riskRules(b.risk))} className="text-sm text-primary hover:underline">{t("segment_short")}</Link> }] : []),
                  ]}
                />
              </CardContent>
            </Card>

            <Card data-testid="calibration">
              <CardHeader>
                <CardTitle className="text-base">{t("model_title")}</CardTitle>
                <CardDescription>{t("model_description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="muted">{t("fitted_at", { at: formatDateTime(o.model.fittedAt, ctx.locale, ctx.tenant.timezone) })}</Badge>
                  <Badge variant="muted">{t("fitted_on", { n: num(o.model.customers) })}</Badge>
                </div>
                {cal ? (
                  <>
                    <p>
                      {t("backtest_summary", { from: formatDate(cal.cutoff, ctx.locale, ctx.tenant.timezone), to: formatDate(cal.end, ctx.locale, ctx.tenant.timezone), predicted: num(cal.predicted), actual: num(cal.actual) })}{" "}
                      {cal.error !== null && <Badge variant={Math.abs(cal.error) <= 0.15 ? "success" : Math.abs(cal.error) <= 0.3 ? "warning" : "destructive"}>{t("backtest_error", { pct: formatPercent(cal.error, ctx.locale, 0) })}</Badge>}
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("columns.repeat")}</TableHead>
                          <TableHead className="text-right">{tc("columns.customers")}</TableHead>
                          <TableHead className="text-right">{t("columns.predicted")}</TableHead>
                          <TableHead className="text-right">{t("columns.actual")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cal.rows.map((r, i) => (
                          <TableRow key={r.repeat}>
                            <TableCell>{i === cal.rows.length - 1 && r.repeat > 0 ? t("repeat_plus", { n: r.repeat }) : num(r.repeat)}</TableCell>
                            <TableCell className="text-right tabular">{num(r.customers)}</TableCell>
                            <TableCell className="text-right tabular">{num(r.predicted)}</TableCell>
                            <TableCell className="text-right tabular">{num(r.actual)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                ) : (
                  <p className="text-muted-foreground">{t("backtest_unavailable")}</p>
                )}
                <p className="text-xs text-muted-foreground">{t("method_note")}</p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            {list(t("slipping_title"), t("slipping_description"), o.slipping, "slipping", slippingRules)}
            {list(t("due_title"), t("due_description"), o.dueSoon, "due-soon")}
          </div>
          <div className="mt-6">{list(t("top_title"), t("top_description"), o.top, "top-value")}</div>
        </>
      )}
    </>
  );
}

export default withIntl(PredictionsPage, "app/t/[tenant]/customers/predictions/page.tsx");
