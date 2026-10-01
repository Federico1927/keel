import Link from "next/link";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDateTime, formatNumber, formatPercent } from "@keel/core";
import { integrationMode } from "@keel/integrations";
import { conversionLog, conversionStats, getConversionSettings, integrationOverview, pixelOverview } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { collectUrlFor, shopifyCustomPixel } from "@/server/pixel-snippets";
import { ConversionForm, CopyBlock, PixelControls, RunConversions } from "./controls";

export default async function TrackingPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "integrations");
  const t = await getTranslations("tracking");
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const { pixel, settings, stats, log, integrations } = await ctx.run(async (tx) => ({
    pixel: await pixelOverview({ ...s, tx }),
    settings: await getConversionSettings({ ...s, tx }),
    stats: await conversionStats({ ...s, tx }),
    log: await conversionLog({ ...s, tx }, 30),
    integrations: (await integrationOverview({ ...s, tx })).integrations,
  }));
  const canManage = canDo(ctx.role, "manage_integrations");
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_APP_URL || `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const collect = collectUrlFor(origin, pixel.settings.publicKey);
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
        <CardHeader>
          <CardTitle className="text-base">{t("log.title")}</CardTitle>
          <CardDescription>{t("log.description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("log.order")}</TableHead>
                <TableHead>{t("log.platform")}</TableHead>
                <TableHead>{t("log.status")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("log.detail")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("log.when")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.map((r) => (
                <TableRow key={r.id} data-testid="conversion-row">
                  <TableCell><Link href={`/t/${tenant}/orders/${r.orderId}`} className="hover:underline">{r.orderName}</Link></TableCell>
                  <TableCell>{t(`conversions.name_${r.provider}`)}</TableCell>
                  <TableCell><Badge variant={r.status === "sent" ? "success" : r.status === "failed" ? "destructive" : r.status === "pending" ? "info" : "muted"}>{t(`log.statuses.${r.status}`)}</Badge></TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{r.reason ? t(`log.reasons.${r.reason}`) : r.lastError ?? (r.attempts > 1 ? t("log.attempts", { n: r.attempts }) : "")}</TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{dt(r.sentAt ?? r.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
