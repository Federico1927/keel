import { formatMoney, formatNumber, formatPercent, type Period } from "@hullwise/core";
import { isCustomMetricRef, metricDefinition, type MetricFilters, type MetricFormat, type MetricLink } from "@hullwise/config";

/** A metric value in its unit: money from minor units, percent from a fraction, ratio as ×, days rounded. */
export function formatMetric(value: number | null | undefined, format: MetricFormat, currency: string, locale: string, daysUnit = "d"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (format) {
    case "money":
      return formatMoney(Math.round(value), currency, locale);
    case "percent":
      return formatPercent(value, locale);
    case "ratio":
      return `${formatNumber(value, locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}×`;
    case "days":
      return `${formatNumber(Math.round(value), locale)} ${daysUnit}`;
    default:
      return formatNumber(value, locale, { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0 });
  }
}

/** Relative change and whether it is good news for the metric (lower-is-better metrics invert the colour). */
export function trendOf(value: number | null, previous: number | null, higherIsBetter: boolean): { value: number; good: boolean | null } | null {
  if (value === null || previous === null || previous === 0) return null;
  const change = (value - previous) / Math.abs(previous);
  return { value: change, good: change === 0 ? null : change > 0 === higherIsBetter };
}

const day = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const periodParams = (p: Period, tz: string) => `from=${day(p.from, tz)}&to=${day(new Date(p.to.getTime() - 1), tz)}`;

function linkPath(link: MetricLink, q: string): string {
  switch (link) {
    case "pnl":
      return `analytics?tab=pnl&${q}`;
    case "orders":
      return `orders?${q}`;
    case "orders_cancelled":
      return `orders?status=cancelled&${q}`;
    case "returns":
      return "returns";
    case "customers":
      return "customers";
    case "inventory":
      return "inventory";
    case "purchasing":
      return "purchasing";
    case "campaigns":
      return "campaigns";
    default:
      // campaigns_<platform>: the campaign list filtered to that ad platform
      return `campaigns?platform=${link.slice("campaigns_".length)}`;
  }
}

/**
 * Where a metric's number clicks through: the list behind it. A filtered custom metric opens the
 * order list with the same filters; an unfiltered one the list of its first base.
 */
export function metricHref(base: string, ref: string, period: Period, tz: string, opts: { filters?: MetricFilters | null; firstBase?: string | null } = {}): string {
  const q = periodParams(period, tz);
  if (isCustomMetricRef(ref)) {
    const f = opts.filters;
    if (f) {
      const params = [q];
      if (f.channel?.[0]) params.push(`attrChannel=${encodeURIComponent(f.channel[0])}`);
      if (f.country?.[0]) params.push(`country=${f.country[0]}`);
      if (f.paymentMethod?.length) params.push(`payment=${f.paymentMethod.map(encodeURIComponent).join(",")}`);
      if (f.campaignIds?.[0]) params.push(`campaign=${f.campaignIds[0]}`);
      if (f.productIds?.[0]) params.push(`product=${f.productIds[0]}`);
      return `${base}/orders?${params.join("&")}`;
    }
    const def = opts.firstBase ? metricDefinition(opts.firstBase) : null;
    return `${base}/${linkPath(def?.link ?? "pnl", q)}`;
  }
  return `${base}/${linkPath(metricDefinition(ref)?.link ?? "pnl", q)}`;
}
