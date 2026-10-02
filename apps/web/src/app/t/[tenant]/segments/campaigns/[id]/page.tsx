import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { listSegments, retentionCampaignDetail } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CampaignForm } from "../campaign-form";
import { UpliftBadge } from "../uplift-badge";
import { SendPanel } from "./send-panel";

export default async function RetentionCampaignPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "customer_campaigns");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("retention");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const detail = await ctx.run((tx) => retentionCampaignDetail({ ...s, tx }, at, id));
  if (!detail) notFound();
  const { campaign: c, segment, results } = detail;
  const canWrite = canWritePage(ctx.role, "customer_campaigns");
  const money = (m: number | null | undefined) => (m === null || m === undefined ? "—" : formatMoney(Math.round(m), ctx.tenant.currency, ctx.locale));
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatPercent(v, ctx.locale, 1));
  const back = <Link href={`/t/${tenant}/segments/campaigns`} className="hover:underline">← {t("tabs.campaigns")}</Link>;
  const chips = (
    <>
      <Badge variant={c.status === "sent" ? "success" : "outline"}>{t(`status.${c.status}`)}</Badge>
      <Badge variant="muted">{t(`channels.${c.channel}`)}</Badge>
      {c.discountCode && <Badge variant="outline" className="font-mono">{c.discountCode}</Badge>}
    </>
  );

  if (c.status === "draft") {
    const segments = (await ctx.run((tx) => listSegments({ ...s, tx }))).map((x) => ({ id: x.id, name: x.name, holdoutPercentage: x.holdoutPercentage, lastCount: x.lastCount }));
    return (
      <DetailShell back={back} eyebrow={ctx.tenant.name} title={c.name} chips={chips} actions={canWrite ? <SendPanel slug={tenant} campaignId={c.id} locale={ctx.locale} /> : undefined}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("draft_title")}</CardTitle>
            <CardDescription>{t("draft_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {canWrite ? (
              <CampaignForm slug={tenant} segments={segments} currency={ctx.tenant.currency} values={{ id: c.id, name: c.name, segmentId: c.segmentId ?? "", channel: c.channel, message: c.message, discountCode: c.discountCode, costPerMessageMinor: c.costPerMessageMinor, attributionDays: c.attributionDays }} />
            ) : (
              <p className="text-sm text-muted-foreground">{c.message || "—"}</p>
            )}
          </CardContent>
        </Card>
      </DetailShell>
    );
  }

  const r = results?.report;
  return (
    <DetailShell
      back={back}
      eyebrow={segment ? segment.name : t("segment_deleted")}
      title={c.name}
      chips={chips}
      aside={
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("delivery_title")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>{t("sent_on", { at: c.sentAt ? formatDateTime(c.sentAt, ctx.locale, ctx.tenant.timezone) : "—" })}</p>
              {detail.exposureStatus.map((x) => (
                <div key={`${x.group}-${x.status}`} className="flex justify-between gap-2"><span className="text-muted-foreground">{t(`exposure.${x.status}`)}</span><span className="tabular">{formatNumber(x.n, ctx.locale)}</span></div>
              ))}
              {c.message && <p className="mt-2 rounded-md bg-muted p-2 text-xs">{c.message}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("method_title")}</CardTitle></CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">{t("method_note", { days: c.attributionDays })}</p></CardContent>
          </Card>
        </div>
      }
    >
      {!results || !r ? null : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <UpliftBadge results={results} locale={ctx.locale} />
            <span className="text-sm text-muted-foreground">{results.windowOpen ? t("window_open", { at: formatDate(results.windowEndsAt, ctx.locale, ctx.tenant.timezone) }) : t("window_closed", { at: formatDate(results.windowEndsAt, ctx.locale, ctx.tenant.timezone) })}</span>
          </div>
          {!r.measurable && <Alert className="mb-4"><AlertDescription>{t("no_holdout_result")}</AlertDescription></Alert>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t("kpi.uplift")} value={r.conversion ? `${r.conversion.diff >= 0 ? "+" : ""}${formatNumber(r.conversion.diff * 100, ctx.locale, { maximumFractionDigits: 1 })} pt` : "—"} hint={r.conversion?.pValue != null ? t("kpi.p_value", { p: formatNumber(r.conversion.pValue, ctx.locale, { maximumFractionDigits: 3 }) }) : undefined} />
            <Stat label={t("kpi.incremental_orders")} value={r.incrementalOrders === null ? "—" : formatNumber(r.incrementalOrders, ctx.locale, { maximumFractionDigits: 0 })} />
            <Stat label={t("kpi.incremental_margin")} value={money(r.incrementalMarginMinor)} hint={r.incrementalMarginCi95 ? t("kpi.ci", { lo: money(r.incrementalMarginCi95[0]), hi: money(r.incrementalMarginCi95[1]) }) : undefined} />
            <Stat label={t("kpi.net")} value={money(r.netIncrementalMarginMinor)} hint={t("kpi.cost", { cost: money(r.costMinor), roi: r.roi === null ? "—" : formatNumber(r.roi, ctx.locale, { maximumFractionDigits: 1 }) })} />
          </div>
          <Card className="mt-6" data-testid="groups-table">
            <CardHeader>
              <CardTitle className="text-base">{t("groups_title")}</CardTitle>
              <CardDescription>{t("groups_description", { days: c.attributionDays })}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead className="text-right">{t("columns.customers")}</TableHead>
                    <TableHead className="text-right">{t("columns.converted")}</TableHead>
                    <TableHead className="text-right">{t("columns.rate")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{t("columns.revenue_pc")}</TableHead>
                    <TableHead className="text-right">{t("columns.margin_pc")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(["treated", "holdout"] as const).map((g) => (
                    <TableRow key={g}>
                      <TableCell className="font-medium">{t(`group.${g}`)}</TableCell>
                      <TableCell className="text-right tabular">{formatNumber(r[g].customers, ctx.locale)}</TableCell>
                      <TableCell className="text-right tabular">{formatNumber(r[g].converters, ctx.locale)}</TableCell>
                      <TableCell className="text-right tabular">{pct(r[g].conversionRate)}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{money(r[g].revenuePerCustomerMinor)}</TableCell>
                      <TableCell className="text-right tabular">{money(r[g].marginPerCustomerMinor)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {c.discountCode && <p className="mt-3 text-sm text-muted-foreground">{t("code_redemptions", { n: results.codeRedemptions, code: c.discountCode })}</p>}
        </>
      )}
    </DetailShell>
  );
}
