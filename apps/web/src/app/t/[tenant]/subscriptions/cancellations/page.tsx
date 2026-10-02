import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatNumber, formatPercent } from "@hullwise/core";
import { cancellationAnalysis, type CancellationDimension } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant } from "@/server/dashboards";
import { ReasonEditor } from "../controls";
import { SubscriptionTabs, svcOf } from "../shared";

import { withIntl } from "@/i18n/intl-scope";
const DIMENSIONS: CancellationDimension[] = ["product", "cohort", "channel"];

/** Cancellation reasons (addon.subscriptions): normalized onto the tenant's list, by product, cohort or acquisition channel, with the monthly trend. */
async function CancellationsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ by?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "subscriptions");
  const t = await getTranslations("subscriptions.cancellations");
  const ts = await getTranslations("subscriptions");
  const by = DIMENSIONS.find((d) => d === sp.by) ?? "product";
  const a = await ctx.run((tx) => cancellationAnalysis(svcOf(ctx, tx), analyticsTenant(ctx), { dimension: by }));
  const label = (code: string) => a.reasons.find((r) => r.code === code)?.label ?? code;
  const n = (v: number) => formatNumber(v, ctx.locale);
  const base = `/t/${tenant}/subscriptions`;
  const topReasons = a.byReason.slice(0, 6).map((r) => r.reasonCode);
  const dimLabel = (v: string) => (by === "channel" && ts.has(`acquisition.channels.${v}`) ? ts(`acquisition.channels.${v}`) : v);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <SubscriptionTabs tenant={tenant} active="cancellations" />
      {a.total === 0 ? <EmptyState title={t("empty_title")} description={t("empty_description")} /> : (
        <>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("by_reason")}</CardTitle><CardDescription>{t("split", { voluntary: a.voluntary, involuntary: a.involuntary })}</CardDescription></CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm" data-testid="reason-breakdown">
                  {a.byReason.map((r) => (
                    <li key={r.reasonCode}>
                      <div className="flex justify-between gap-2"><Link href={`${base}/subscribers?reason=${r.reasonCode}`} className="hover:underline">{label(r.reasonCode)}</Link><span className="tabular">{n(r.count)} · {formatPercent(r.share, ctx.locale, 0)}</span></div>
                      <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round(r.share * 100)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">{t("matrix")}</CardTitle>
                <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">{DIMENSIONS.map((d) => <Link key={d} href={`${base}/cancellations?by=${d}`} className={cn("rounded-sm px-2 py-1", d === by ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`dimension.${d}`)}</Link>)}</div>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table data-testid="reason-matrix">
                  <TableHeader><TableRow><TableHead>{t(`dimension.${by}`)}</TableHead><TableHead className="text-right">{t("total")}</TableHead>{topReasons.map((r) => <TableHead key={r} className="text-right">{label(r)}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>{a.matrix.slice(0, 20).map((m) => <TableRow key={m.dimension}><TableCell className="max-w-48 truncate">{dimLabel(m.dimension)}</TableCell><TableCell className="text-right tabular">{n(m.total)}</TableCell>{topReasons.map((r) => <TableCell key={r} className="text-right tabular">{m.byReason[r] ? n(m.byReason[r]) : ""}</TableCell>)}</TableRow>)}</TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader><CardTitle className="text-base">{t("trend")}</CardTitle><CardDescription>{t("trend_description")}</CardDescription></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="reason-trend">
                <TableHeader><TableRow><TableHead>{t("month")}</TableHead><TableHead className="text-right">{t("total")}</TableHead>{topReasons.map((r) => <TableHead key={r} className="text-right">{label(r)}</TableHead>)}</TableRow></TableHeader>
                <TableBody>{a.trend.map((m) => <TableRow key={m.month}><TableCell>{m.month}</TableCell><TableCell className="text-right tabular">{n(m.total)}</TableCell>{topReasons.map((r) => <TableCell key={r} className="text-right tabular">{m.byReason[r] ? n(m.byReason[r]) : ""}</TableCell>)}</TableRow>)}</TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("list_title")}</CardTitle><CardDescription>{t("list_description")}</CardDescription></CardHeader>
        <CardContent>{canDo(ctx.role, "manage_settings") ? <ReasonEditor slug={tenant} reasons={a.reasons.map((r) => ({ code: r.code, label: r.label, kind: r.kind, keywords: [...r.keywords], isActive: r.isActive }))} /> : <ul className="text-sm">{a.reasons.map((r) => <li key={r.code}>{r.label}</li>)}</ul>}</CardContent>
      </Card>
    </>
  );
}

export default withIntl(CancellationsPage, "app/t/[tenant]/subscriptions/cancellations/page.tsx");
