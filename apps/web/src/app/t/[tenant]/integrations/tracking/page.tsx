import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatDateTime, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { conversionLog, conversionStats, getConversionSettings, integrationOverview, pixelOverview } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { collectUrlFor, shopifyCustomPixel } from "@/server/pixel-snippets";
import { ConversionForm, CopyBlock, PixelControls, RunConversions } from "./controls";

import { withIntl } from "@/i18n/intl-scope";
async function TrackingPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ log?: string }> }) {
  const { tenant } = await params;
  // the log: every event, or the retractions and restatements alone (#82)
  const adjustmentsOnly = (await searchParams).log === "adjustments";
  const ctx = await requirePage(tenant, "integrations");
  const t = await getTranslations("tracking");
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const { pixel, settings, stats, log, integrations } = await ctx.run(async (tx) => ({
    pixel: await pixelOverview({ ...s, tx }),
    settings: await getConversionSettings({ ...s, tx }),
    stats: await conversionStats({ ...s, tx }),
    log: await conversionLog({ ...s, tx }, 30, adjustmentsOnly ? { kinds: "adjustments" } : {}),
    integrations: (await integrationOverview({ ...s, tx })).integrations,
  }));
  const canManage = canDo(ctx.role, "manage_integrations");
  const collect = collectUrlFor(pixel.settings.publicKey);
  const scriptTag = `<script async src="${collect}/script.js"></script>`;
  const num = (n: number) => formatNumber(n, ctx.locale);
  const dt = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const live = (p: string) => integrationMode() === "live" && integrations.some((i) => i.provider === p && i.mode === "live" && i.status !== "not_connected");
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/integrations`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<Link href={`/t/${tenant}/integrations/guide/tracking`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t("guide_link")}</Link>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="pixel-stats">
        <Stat label={t("pixel.kpi.events")} value={num(pixel.events)} hint={t("pixel.kpi.last", { at: dt(pixel.lastEventAt) })} />
        <Stat label={t("pixel.kpi.sessions")} value={num(pixel.sessions)} hint={t("pixel.kpi.visitors", { n: num(pixel.visitors) })} />
        <Stat label={t("pixel.kpi.identified")} value={num(pixel.identifiedVisitors)} />
        <Stat label={t("pixel.kpi.orders")} value={pixel.orders ? formatPercent(pixel.ordersWithPixel / pixel.orders, ctx.locale, 0) : "—"} hint={t("pixel.kpi.orders_hint", { n: num(pixel.ordersWithPixel), total: num(pixel.orders) })} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("pixel.title")}</CardTitle>
            <CardDescription>{t("pixel.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("pixel.shopify_title")}</p>
              <p className="text-xs text-muted-foreground">{t("pixel.shopify_help")}</p>
              <CopyBlock code={shopifyCustomPixel(collect)} testId="pixel-shopify" />
            </div>
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("pixel.script_title")}</p>
              <p className="text-xs text-muted-foreground">{t("pixel.script_help")}</p>
              <CopyBlock code={scriptTag} testId="pixel-script" />
            </div>
            <PixelControls slug={tenant} enabled={pixel.settings.enabled} allowedOrigins={pixel.settings.allowedOrigins} lookbackDays={pixel.settings.lookbackDays} canManage={canManage} />
            {pixel.byChannel.length > 0 && (
              <div className="flex flex-wrap gap-1 text-xs">
                {pixel.byChannel.map((c) => (
                  <Badge key={c.channel} variant="muted">{c.channel} · {num(c.sessions)}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("conversions.title")}</CardTitle>
            <CardDescription>{t("conversions.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {settings.map((cs) => {
              const st = stats.find((x) => x.provider === cs.provider)!;
              return (
                <div key={cs.provider} className="space-y-3 border-b pb-4 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(`conversions.name_${cs.provider}`)}</span>
                    <Badge variant={live(cs.provider) ? "success" : "muted"}>{live(cs.provider) ? t("live") : t("mock")}</Badge>
                    <span className="text-xs text-muted-foreground" data-testid={`conversions-stats-${cs.provider}`}>{t("conversions.stats", { sent: st.sent, failed: st.failed, pending: st.pending, consent: st.skippedConsent, ident: st.skippedIdentifier })}</span>
                    {(st.adjusted > 0 || st.unsupported > 0) && <span className="text-xs text-muted-foreground" data-testid={`conversions-adjustments-${cs.provider}`}>{t("conversions.adjustment_stats", { adjusted: st.adjusted, unsupported: st.unsupported })}</span>}
                  </div>
                  <ConversionForm slug={tenant} provider={cs.provider} value={cs} canManage={canManage} />
                </div>
              );
            })}
            {canManage && <RunConversions slug={tenant} />}
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{t("log.title")}</CardTitle>
            <CardDescription>{t("log.description")}</CardDescription>
          </div>
          <div className="flex gap-1 text-sm" data-testid="conversion-log-filter">
            <Link href={`/t/${tenant}/integrations/tracking`} className={`rounded-md border px-2 py-1 ${adjustmentsOnly ? "hover:bg-muted" : "bg-muted font-medium"}`}>{t("log.filter_all")}</Link>
            <Link href={`/t/${tenant}/integrations/tracking?log=adjustments`} className={`rounded-md border px-2 py-1 ${adjustmentsOnly ? "bg-muted font-medium" : "hover:bg-muted"}`} data-testid="conversion-log-adjustments">{t("log.filter_adjustments")}</Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {log.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("log.empty")}</p>
          ) : (
            <DataList
              rows={log}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "conversion-row", "data-kind": r.kind, "data-status": r.status, "data-provider": r.provider })}
              columns={[
                { key: "order", header: t("log.order"), mobile: "title", cell: (r) => <Link href={`/t/${tenant}/orders/${r.orderId}`} className="hover:underline">{r.orderName}</Link> },
                { key: "status", header: t("log.status"), mobile: "badge", label: "", cell: (r) => <Badge variant={r.status === "sent" ? "success" : r.status === "failed" ? "destructive" : r.status === "pending" ? "info" : "muted"}>{t(`log.statuses.${r.status}`)}</Badge> },
                { key: "kind", header: t("log.kind"), cell: (r) => <span className={r.kind === "purchase" ? "" : "font-medium"}>{t(`log.kinds.${r.kind}`)}{r.kind === "restatement" && r.valueMinor !== null ? ` · ${t("log.value", { value: formatMoney(r.valueMinor, r.currency, ctx.locale) })}` : ""}</span> },
                { key: "platform", header: t("log.platform"), cell: (r) => t(`conversions.name_${r.provider}`) },
                { key: "detail", header: t("log.detail"), priority: 2, cell: (r) => <span className="text-xs">{r.reason ? t(`log.reasons.${r.reason}`) : r.lastError ?? (r.attempts > 1 ? t("log.attempts", { n: r.attempts }) : "")}</span> },
                { key: "when", header: t("log.when"), mobile: "detail", cell: (r) => <span className="whitespace-nowrap text-xs">{dt(r.sentAt ?? r.createdAt)}</span> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(TrackingPage, "app/t/[tenant]/integrations/tracking/page.tsx");
