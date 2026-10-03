import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CircleCheck } from "lucide-react";
import { PRODUCT_NAME } from "@hullwise/config";
import { dataHealthHref, formatDate, formatMoney, formatNumber, type DataHealthItem, type DataHealthReport, type DataHealthSeverity } from "@hullwise/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from "@hullwise/ui";

export interface DataHealthEnv {
  base: string;
  locale: string;
  currency: string;
  timezone: string;
}

const DOT: Record<DataHealthSeverity, string> = { critical: "bg-destructive", warning: "bg-warning", info: "bg-info" };
const BADGE: Record<DataHealthSeverity, "destructive" | "warning" | "info"> = { critical: "destructive", warning: "warning", info: "info" };

type T = Awaited<ReturnType<typeof getTranslations>>;

/** Message values of a gap: counts and money formatted, lists joined in the viewer's language, months spelled out. */
async function messageValues(item: DataHealthItem, env: DataHealthEnv) {
  const tp = await getTranslations("payment_methods");
  const ti = await getTranslations("integrations.providers");
  const list = (xs: string[]) => new Intl.ListFormat(env.locale, { type: "conjunction" }).format(xs);
  const p = item.params;
  const arr = (k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);
  const month = typeof p.month === "string" ? formatDate(new Date(`${p.month}-15T12:00:00Z`), env.locale, "UTC", { month: "long", year: "numeric" }) : "";
  return {
    count: item.count,
    countLabel: formatNumber(item.count, env.locale),
    sample: formatNumber(item.sample, env.locale),
    orders: formatNumber(item.affectedOrders ?? 0, env.locale),
    revenue: formatMoney(item.affectedRevenueMinor ?? 0, env.currency, env.locale),
    methods: list(arr("methods").map((m) => (tp.has(m) ? tp(m) : m))),
    countries: list(arr("countries")),
    providers: list(arr("providers").map((x) => (ti.has(x) ? ti(x) : x))),
    month,
    product: PRODUCT_NAME,
  };
}

async function Row({ item, env, t, testId = "setup-health-row" }: { item: DataHealthItem; env: DataHealthEnv; t: T; testId?: string }) {
  const values = await messageValues(item, env);
  return (
    <li>
      <Link href={`${env.base}/${dataHealthHref(item)}`} className="flex gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/50 pointer-coarse:py-2.5" data-testid={testId} data-check={item.id} data-severity={item.severity}>
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[item.severity])} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2 text-sm font-medium">
            <span className="min-w-0 break-words">{t(`checks.${item.id}.title`, values)}</span>
            <Badge variant={BADGE[item.severity]} className="shrink-0">{t(`severity.${item.severity}`)}</Badge>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t(`checks.${item.id}.impact`, values)}</span>
        </span>
      </Link>
    </li>
  );
}

/** Score and counts by severity, one line. */
function Summary({ report, t, locale }: { report: DataHealthReport; t: T; locale: string }) {
  const s = report.summary;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground" data-testid="setup-health-summary">
      <span className="font-medium text-foreground tabular" data-testid="setup-health-score">{t("score", { score: formatNumber(s.score, locale) })}</span>
      {(["critical", "warning", "info"] as const).filter((k) => s[k] > 0).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={cn("size-2 rounded-full", DOT[k])} aria-hidden />{t(`summary.${k}`, { n: s[k] })}</span>)}
    </p>
  );
}

function AllSet({ t }: { t: T }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center" data-testid="setup-health-empty">
      <CircleCheck className="size-8 text-success" aria-hidden />
      <p className="text-sm font-medium">{t("all_set")}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{t("all_set_hint")}</p>
    </div>
  );
}

/**
 * The home widget (#99): a fixed-height card (its grid cell reserves the same height, so nothing moves
 * while it streams); the list scrolls inside when there are more gaps than fit.
 */
export async function DataHealthWidget({ report, env }: { report: DataHealthReport; env: DataHealthEnv }) {
  const t = await getTranslations("data_health");
  return (
    <Card className="flex h-[26rem] flex-col" data-testid="widget-setup-health">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="truncate text-base">{t("title")}</CardTitle>
        <Link href={`${env.base}/data-health`} className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline" data-testid="setup-health-all">{t("see_all")}</Link>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {report.items.length === 0 ? <AllSet t={t} /> : (
          <>
            <Summary report={report} t={t} locale={env.locale} />
            <ul className="space-y-0.5">{await Promise.all(report.items.map((i) => <Row key={i.id} item={i} env={env} t={t} />))}</ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The full list (the "See all" page): gaps with their numbers, then what is complete and what does not apply. */
export async function DataHealthDetails({ report, env }: { report: DataHealthReport; env: DataHealthEnv }) {
  const t = await getTranslations("data_health");
  const pct = (x: number | null) => (x === null ? null : new Intl.NumberFormat(env.locale, { style: "percent", maximumFractionDigits: 1 }).format(x));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">{t("page.gaps_title")}</CardTitle>
          <Summary report={report} t={t} locale={env.locale} />
        </CardHeader>
        <CardContent>
          {report.items.length === 0 ? <div className="py-8"><AllSet t={t} /></div> : (
            <ul className="divide-y">
              {await Promise.all(report.items.map(async (i) => (
                <li key={i.id} className="py-2" data-testid="data-health-item" data-check={i.id}>
                  <ul><Row item={i} env={env} t={t} testId="data-health-fix" /></ul>
                  <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-xs text-muted-foreground tabular">
                    <span>{t("page.found", { count: formatNumber(i.count, env.locale), sample: formatNumber(i.sample, env.locale) })}</span>
                    {i.affectedOrders !== null && <span>{t("page.orders", { n: formatNumber(i.affectedOrders, env.locale) })}</span>}
                    {i.affectedRevenueMinor !== null && <span>{t(i.id === "campaign_links" ? "page.spend" : "page.revenue", { amount: formatMoney(i.affectedRevenueMinor, env.currency, env.locale) })}</span>}
                    {pct(i.share) && <span>{t("page.share", { share: pct(i.share)! })}</span>}
                  </p>
                </li>
              )))}
            </ul>
          )}
        </CardContent>
      </Card>
      {report.passed.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("page.passed_title")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2" data-testid="data-health-passed">
              {report.passed.map((id) => <li key={id} className="flex items-center gap-2"><CircleCheck className="size-4 shrink-0 text-success" aria-hidden />{t(`checks.${id}.name`)}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}
      {report.skipped.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("page.skipped_title")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">{report.skipped.map((id) => <li key={id}>{t(`checks.${id}.name`)} · {t("page.not_applicable")}</li>)}</ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
