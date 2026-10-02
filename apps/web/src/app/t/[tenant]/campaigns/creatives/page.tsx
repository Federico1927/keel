import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adPlatformsForPlan } from "@hullwise/config";
import { formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { creativePerformance } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, cn, DataList } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CHART_COLORS } from "@/components/charts/theme";
import { PeriodPicker } from "@/components/period-picker";
import { periodParams, resolvePeriod } from "@/server/period";
import { AdsNav } from "../ads-table";

/** Local placeholder thumbnail: platform previews need the ad account's CDN; this keeps the demo offline. */
function CreativeThumb({ format, label }: { format: string | null; label: string }) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <svg viewBox="0 0 64 64" className="h-12 w-12 shrink-0 rounded-md" aria-hidden>
      <defs><linearGradient id={`g${h}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={CHART_COLORS[h % CHART_COLORS.length]} /><stop offset="1" stopColor={CHART_COLORS[(h + 2) % CHART_COLORS.length]} /></linearGradient></defs>
      <rect width="64" height="64" fill={`url(#g${h})`} />
      {format === "video" && <polygon points="26,20 46,32 26,44" fill="white" opacity="0.9" />}
      {format === "carousel" && <g fill="white" opacity="0.85"><rect x="12" y="18" width="18" height="28" rx="2" /><rect x="34" y="18" width="18" height="28" rx="2" opacity="0.6" /></g>}
      {format === "image" && <g fill="white" opacity="0.85"><circle cx="24" cy="24" r="6" /><polygon points="12,48 28,32 38,42 44,36 54,48" /></g>}
      {format === "text" && <g fill="white" opacity="0.85"><rect x="12" y="20" width="40" height="4" /><rect x="12" y="30" width="32" height="4" /><rect x="12" y="40" width="36" height="4" /></g>}
    </svg>
  );
}

export default async function CreativesPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ preset?: string; from?: string; to?: string; by?: string; platform?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("campaigns.creatives");
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const by = (["creative", "format", "hook", "angle"] as const).find((b) => b === sp.by) ?? "creative";
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const rows = await ctx.run((tx) => creativePerformance({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, period, by, { platform: adPlatformsForPlan(ctx.tenant.planKey).find((p) => p === sp.platform) }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const ratio = (r: number | null) => (r === null ? "—" : `${r.toFixed(2)}×`);
  const base = `/t/${tenant}/campaigns/creatives`;
  const qs = (patch: Record<string, string>) => `${base}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))), by, ...(sp.platform ? { platform: sp.platform } : {}), ...patch })}`;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/campaigns`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<PeriodPicker basePath={base} keep={{ by, platform: sp.platform }} preset={period.preset} from={sp.from} to={sp.to} />} />
      <AdsNav tenant={tenant} active="creatives" qs={new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString()} />
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-md bg-muted p-1 text-sm">
        {(["creative", "format", "hook", "angle"] as const).map((b) => <Link key={b} href={qs({ by: b })} className={cn("flex-1 shrink-0 whitespace-nowrap rounded-sm px-3 py-1.5 text-center pointer-coarse:py-2.5", by === b ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`by.${b}`)}</Link>)}
      </div>
      {rows.length === 0 ? <EmptyState title={t("empty")} /> : (
        <Card>
          <CardContent className="p-0">
            <DataList
              data-testid="creatives-table"
              rows={rows}
              rowKey={(r) => r.key}
              rowProps={() => ({ "data-testid": "creative-row" })}
              columns={[
                { key: "label", header: t(`by.${by}`), mobile: "title", cell: (r) => <div className="flex items-center gap-3"><CreativeThumb format={r.format} label={r.label} /><div className="min-w-0"><div className="truncate font-medium">{r.label}</div><div className="flex flex-wrap gap-1 text-xs font-normal text-muted-foreground">{by === "creative" ? <>{r.campaignId && <Link href={`/t/${tenant}/campaigns/${r.campaignId}`} className="relative z-10 hover:underline">{r.campaignName}</Link>}{r.format && <Badge variant="outline">{r.format}</Badge>}{r.status === "paused" && <Badge variant="muted">{t("paused")}</Badge>}</> : t("n_creatives", { n: r.creatives })}</div></div></div> },
                { key: "roas", header: t("roas"), mobile: "badge", align: "right", className: "tabular font-medium", cell: (r) => <span className={cn(r.roas !== null && r.roas < 1 && "text-destructive")}>{ratio(r.roas)}</span> },
                { key: "spend", header: t("spend"), align: "right", className: "tabular", cell: (r) => money(r.spendMinor) },
                { key: "ctr", header: t("ctr"), align: "right", className: "tabular", cell: (r) => formatPercent(r.ctr, ctx.locale, 2) },
                { key: "cpc", header: t("cpc"), align: "right", priority: 2, className: "tabular", cell: (r) => (r.cpcMinor !== null ? money(r.cpcMinor) : "—") },
                { key: "thumbstop", header: t("thumbstop"), align: "right", priority: 3, className: "tabular", cell: (r) => formatPercent(r.thumbStopRate, ctx.locale, 0) },
                { key: "declared", header: t("declared"), align: "right", className: "tabular", cell: (r) => <>{formatNumber(r.declaredPurchases, ctx.locale)} · {money(r.declaredValueMinor)}</> },
                { key: "real", header: t("real"), align: "right", className: "tabular", cell: (r) => <>{formatNumber(r.orders, ctx.locale)} · {money(r.netMinor)}</> },
                ...(by === "creative" ? [{ key: "fatigue", header: t("fatigue"), label: "", cell: (r: (typeof rows)[number]) => (r.fatigue && r.fatigue.level !== "no_data" ? <Badge variant={r.fatigue.level === "fatigued" ? "destructive" : r.fatigue.level === "watch" ? "warning" : "success"} title={t("fatigue_hint", { change: formatPercent(r.fatigue.ctrChange, ctx.locale, 0), freq: r.fatigue.frequency?.toFixed(1) ?? "—" })}>{t(`fatigue_levels.${r.fatigue.level}`)}</Badge> : <span className="text-xs text-muted-foreground max-md:hidden">—</span>) }] : []),
              ]}
            />
            <p className="border-t p-3 text-xs text-muted-foreground">{t("footnote")}</p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
