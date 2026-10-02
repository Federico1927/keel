import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME, isAnalyticsPlatformInPlan } from "@hullwise/config";
import { formatNumber, formatPercent, type ConversionRateRow, type Period } from "@hullwise/core";
import { conversionReport } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, Stat, type DataListColumn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";

/**
 * Traffic tab (#86): conversion rate (online orders ÷ GA4 sessions) by channel and by landing page,
 * next to the same orders ÷ first-party pixel sessions, with why the two differ. Every number links to
 * its source: orders to the orders list, sessions to the GA4 rows view.
 */
export async function TrafficTab({ ctx, tenant, period, periodQs, fromIso, toIso }: { ctx: TenantContext; tenant: string; period: Period; periodQs: string; fromIso: string; toIso: string }) {
  const t = await getTranslations("ga4.analytics");
  const ta = await getTranslations("analytics");
  if (!isAnalyticsPlatformInPlan(ctx.tenant.planKey)) return <EmptyState title={t("not_in_plan")} className="mt-2" />;
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const at = { timezone: ctx.tenant.timezone };
  const [channels, landing] = await ctx.run(async (tx) => [await conversionReport(s(tx), at, period, "channel"), await conversionReport(s(tx), at, period, "landing", { limit: 25 })] as const);
  if (!channels.state.connected) return (
    <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-2" action={<Link href={`/t/${tenant}/integrations?setup=ga4`} className="text-sm font-medium underline-offset-4 hover:underline" data-testid="ga4-empty-cta">{t("empty_cta")}</Link>} />
  );
  const pct = (v: number | null) => (v === null ? "—" : formatPercent(v, ctx.locale, 2));
  const num = (v: number | null) => (v === null ? "—" : formatNumber(v, ctx.locale));
  const ordersHref = (extra: string) => `/t/${tenant}/orders?from=${fromIso}&to=${toIso}&channel=web${extra}`;
  const rowsHref = (extra: string) => `/t/${tenant}/analytics/traffic?${periodQs}${extra}`;
  const channelLabel = (k: string) => ta(`ltv.channel.${k}`, { default: k });
  const columns = (by: "channel" | "landing"): DataListColumn<ConversionRateRow>[] => {
    const param = (r: ConversionRateRow) => (by === "channel" ? `&attrChannel=${encodeURIComponent(r.key)}` : `&landing=${encodeURIComponent(r.key)}`);
    const rowParam = (r: ConversionRateRow) => (by === "channel" ? `&channel=${encodeURIComponent(r.key)}` : `&landing=${encodeURIComponent(r.key)}`);
    return [
      { key: "key", header: by === "channel" ? t("channel") : t("landing"), mobile: "title", className: "md:max-w-[22rem]", cell: (r) => <span className={by === "landing" ? "block truncate font-mono text-xs max-md:text-sm" : "font-medium"} title={r.key}>{by === "channel" ? channelLabel(r.key) : r.key}</span> },
      { key: "orders", header: t("orders"), align: "right", className: "tabular", cell: (r) => <Link href={ordersHref(param(r))} className="underline-offset-4 hover:underline" data-testid={`orders-link-${by}`}>{num(r.orders)}</Link> },
      { key: "sessions", header: t("ga4_sessions"), align: "right", className: "tabular", cell: (r) => (r.sessions ? <Link href={rowsHref(rowParam(r))} className="underline-offset-4 hover:underline" data-testid={`sessions-link-${by}`}>{num(r.sessions)}</Link> : "—") },
      { key: "rate", header: t("ga4_cr"), align: "right", className: "tabular font-medium", cell: (r) => <span data-testid={`ga4-cr-${by}`}>{pct(r.rate)}</span> },
      { key: "pixel", header: t("pixel_sessions"), align: "right", priority: 2, className: "tabular text-muted-foreground", cell: (r) => num(r.pixelSessions) },
      { key: "pixelRate", header: t("pixel_cr"), align: "right", priority: 2, className: "tabular text-muted-foreground", cell: (r) => pct(r.pixelRate) },
      { key: "engaged", header: t("engagement"), align: "right", priority: 3, className: "tabular", cell: (r) => pct(r.sessions ? r.engagedSessions / r.sessions : null) },
      { key: "atc", header: t("add_to_carts"), align: "right", priority: 3, className: "tabular", cell: (r) => num(r.addToCarts) },
    ];
  };
  const tot = channels.totals;
  const footer = { key: t("totals"), orders: <Link href={ordersHref("")} className="underline-offset-4 hover:underline">{num(tot.orders)}</Link>, sessions: <Link href={rowsHref("")} className="underline-offset-4 hover:underline">{num(tot.sessions)}</Link>, rate: pct(tot.rate), pixel: num(tot.pixelSessions), pixelRate: pct(tot.pixelRate), engaged: pct(tot.sessions ? tot.engagedSessions / tot.sessions : null), atc: num(tot.addToCarts) };
  return (
    <div className="space-y-6" data-testid="traffic-tab">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("ga4_cr")} value={pct(tot.rate)} hint={t("cr_hint", { orders: num(tot.orders), sessions: num(tot.sessions) })} href={rowsHref("")} />
        <Stat label={t("ga4_sessions")} value={num(tot.sessions)} hint={channels.state.propertyName ?? channels.state.propertyId ?? ""} href={rowsHref("")} />
        <Stat label={t("pixel_cr")} value={pct(tot.pixelRate)} hint={channels.pixelFrom ? t("pixel_since", { date: channels.pixelFrom }) : t("pixel_none")} href={`/t/${tenant}/integrations/tracking`} />
        <Stat label={t("orders")} value={num(tot.orders)} hint={t("orders_hint")} href={ordersHref("")} />
      </div>
      <Card data-testid="traffic-by-channel">
        <CardHeader>
          <CardTitle className="text-base">{t("by_channel")}</CardTitle>
          <CardDescription>{t("by_channel_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" data-scroll="x" role="region" aria-label={t("by_channel")} tabIndex={0}>
            <DataList rows={channels.rows} rowKey={(r) => r.key} rowProps={(r) => ({ "data-testid": "traffic-channel-row", "data-key": r.key })} columns={columns("channel")} footer={footer} caption={t("by_channel")} />
          </div>
        </CardContent>
      </Card>
      <Card data-testid="traffic-why">
        <CardHeader><CardTitle className="text-base">{t("why_title")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {(t.raw("why_points") as string[]).map((p, i) => <li key={i}>{p.replaceAll("{product}", PRODUCT_NAME)}</li>)}
          </ul>
        </CardContent>
      </Card>
      <Card data-testid="traffic-by-landing">
        <CardHeader>
          <CardTitle className="text-base">{t("by_landing")}</CardTitle>
          <CardDescription>{t("by_landing_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {landing.rows.length === 0 ? <EmptyState title={t("no_rows")} className="m-4" /> : (
            <div className="overflow-x-auto" data-scroll="x" role="region" aria-label={t("by_landing")} tabIndex={0}>
              <DataList rows={landing.rows} rowKey={(r) => r.key} rowProps={() => ({ "data-testid": "traffic-landing-row" })} columns={columns("landing")} caption={t("by_landing")} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
