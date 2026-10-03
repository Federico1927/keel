import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { isAnalyticsPlatformInPlan } from "@hullwise/config";
import { formatNumber, formatPercent } from "@hullwise/core";
import { and, eq, schema } from "@hullwise/db";
import { trafficRows, trafficState, type TrafficFilters } from "@hullwise/services";
import { Badge, Card, CardContent, DataList, EmptyState, PageHeader, Pagination } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";

import { withIntl } from "@/i18n/intl-scope";
const FILTER_KEYS = ["channel", "source", "medium", "campaign", "campaignId", "landing"] as const;

/**
 * The GA4 rows behind a number (#86): the stored daily rows of the connected property, filtered by
 * channel, source / medium, campaign (by name or by the Hullwise campaign it matches) and landing path.
 */
async function TrafficRowsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("ga4.rows");
  const ta = await getTranslations("analytics");
  const base = `/t/${tenant}/analytics/traffic`;
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const isUuid = (v: string | undefined) => /^[0-9a-f-]{36}$/i.test(v ?? "");
  const filters: TrafficFilters = { channel: sp.channel || undefined, source: sp.source || undefined, medium: sp.medium || undefined, campaignName: sp.campaign || undefined, campaignId: isUuid(sp.campaignId) ? sp.campaignId : undefined, landing: sp.landing || undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const inPlan = isAnalyticsPlatformInPlan(ctx.tenant.planKey);
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const { state, data, campaignName } = inPlan ? await ctx.run(async (tx) => ({
    state: await trafficState(s(tx)),
    data: await trafficRows(s(tx), { timezone: ctx.tenant.timezone }, period, filters, { page }),
    campaignName: filters.campaignId ? ((await tx.select({ name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.id, filters.campaignId))).limit(1))[0]?.name ?? null) : null,
  })) : { state: null, data: null, campaignName: null };
  const keep = periodParams(period, sp);
  const active = FILTER_KEYS.filter((k) => sp[k]);
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...Object.fromEntries(FILTER_KEYS.map((k) => [k, sp[k]])), ...patch })) if (v) u.set(k, v);
    return `${base}?${u}`;
  };
  const num = (v: number) => formatNumber(v, ctx.locale);
  const label = (k: (typeof FILTER_KEYS)[number]) => (k === "channel" ? ta(`ltv.channel.${sp.channel}`, { default: sp.channel ?? "" }) : k === "campaignId" ? (campaignName ?? sp.campaignId ?? "") : (sp[k] ?? ""));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics?tab=traffic&${new URLSearchParams(Object.entries(keep).filter((e): e is [string, string] => Boolean(e[1])))}`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={state?.propertyName ? t("description_property", { name: state.propertyName }) : t("description")} actions={<PeriodPicker basePath={base} keep={Object.fromEntries(FILTER_KEYS.map((k) => [k, sp[k]]))} preset={period.preset} from={sp.from} to={sp.to} />} />
      {active.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="traffic-filters">
          {active.map((k) => <Link key={k} href={qs({ [k]: undefined, page: undefined })} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-muted pointer-coarse:py-2"><span className="text-muted-foreground">{t(`filters.${k}`)}:</span> <span className="max-w-[14rem] truncate">{label(k)}</span> ×</Link>)}
          <Link href={qs(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))} className="text-xs underline-offset-4 hover:underline">{t("clear")}</Link>
        </div>
      )}
      {!inPlan ? <EmptyState title={t("not_in_plan")} /> : !state?.connected || !data ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} action={<Link href={`/t/${tenant}/integrations`} className="text-sm font-medium underline-offset-4 hover:underline">{t("empty_cta")}</Link>} />
      ) : (
        <Card>
          <CardContent className="space-y-3 p-0">
            <p className="px-4 pt-4 text-sm text-muted-foreground" data-testid="traffic-rows-totals">{t("totals", { sessions: num(data.totals.sessions), engaged: formatPercent(data.totals.sessions ? data.totals.engagedSessions / data.totals.sessions : null, ctx.locale), atc: num(data.totals.addToCarts) })}</p>
            {data.rows.length === 0 ? <EmptyState title={t("no_rows")} className="m-4" /> : (
              <div className="overflow-x-auto" data-scroll="x" role="region" aria-label={t("title")} tabIndex={0}>
                <DataList
                  rows={data.rows}
                  rowKey={(r, i) => `${r.date}|${r.channelGroup}|${r.source}|${r.medium}|${r.campaignName}|${r.landingPath}|${i}`}
                  rowProps={() => ({ "data-testid": "traffic-row" })}
                  caption={t("title")}
                  columns={[
                    { key: "landing", header: t("columns.landing"), mobile: "title", className: "md:max-w-[20rem]", cell: (r) => <Link href={qs({ landing: r.landingPath, page: undefined })} className="block truncate font-mono text-xs max-md:text-sm" title={r.landingPath}>{r.landingPath}</Link> },
                    { key: "date", header: t("columns.date"), mobile: "badge", className: "whitespace-nowrap tabular text-xs", cell: (r) => r.date },
                    { key: "channel", header: t("columns.channel"), mobile: "subtitle", cell: (r) => <Link href={qs({ channel: r.channel, page: undefined })} className="hover:underline"><Badge variant="outline">{r.channelGroup}</Badge></Link> },
                    { key: "source", header: t("columns.source_medium"), cell: (r) => <Link href={qs({ source: r.source, medium: r.medium, page: undefined })} className="hover:underline">{r.source} / {r.medium}</Link> },
                    { key: "campaign", header: t("columns.campaign"), className: "md:max-w-[14rem] truncate", cell: (r) => <Link href={qs({ campaign: r.campaignName, page: undefined })} className="hover:underline" title={r.campaignName}>{r.campaignName}</Link> },
                    { key: "sessions", header: t("columns.sessions"), align: "right", className: "tabular font-medium", cell: (r) => num(r.sessions) },
                    { key: "engaged", header: t("columns.engaged"), align: "right", priority: 2, className: "tabular", cell: (r) => num(r.engagedSessions) },
                    { key: "users", header: t("columns.users"), align: "right", priority: 3, className: "tabular", cell: (r) => num(r.totalUsers) },
                    { key: "atc", header: t("columns.add_to_carts"), align: "right", priority: 2, className: "tabular", cell: (r) => num(r.addToCarts) },
                  ]}
                />
              </div>
            )}
            <Pagination className="px-4 pb-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => qs({ page: String(p) })} summary={t("summary", { n: num(data.total) })} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(TrafficRowsPage, "app/t/[tenant]/analytics/traffic/page.tsx");
