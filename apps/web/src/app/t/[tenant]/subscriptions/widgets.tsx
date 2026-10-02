import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import type { SubsActiveData, SubsAtRiskData, SubsChurnData, SubsMrrData } from "@hullwise/services";
import { cn } from "@hullwise/ui";

export type SubscriptionWidgetType = "subs_mrr" | "subs_active" | "subs_churn" | "subs_at_risk";

/** Home widgets of addon.subscriptions (#67); the data is refused server-side for tenants without the add-on. */
export async function SubscriptionWidget({ type, data, base, locale }: { type: SubscriptionWidgetType; data: unknown; base: string; locale: string }) {
  const t = await getTranslations("subscriptions.widgets");
  const td = await getTranslations("dashboards");
  const tile = (path: string, testId: string, value: React.ReactNode, hint: React.ReactNode, alert = false) => (
    <Link href={`${base}/${path}`} className="flex h-full flex-col justify-between rounded-lg border bg-card p-(--density-stat) shadow-sm transition-colors hover:bg-muted/40" data-testid={`widget-${type}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{td(`widget_types.${type}.name`)}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular", alert && "text-destructive")} data-testid={testId}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </Link>
  );
  if (type === "subs_mrr") {
    const d = data as SubsMrrData;
    const delta = d.previousMinor ? (d.mrrMinor - d.previousMinor) / d.previousMinor : null;
    return tile(d.path, "subs-mrr", formatMoney(d.mrrMinor, d.currency, locale), delta === null ? t("mrr_no_previous") : t("mrr_hint", { delta: `${delta >= 0 ? "+" : ""}${formatPercent(delta, locale)}` }));
  }
  if (type === "subs_active") {
    const d = data as SubsActiveData;
    return tile(d.path, "subs-active", formatNumber(d.active, locale), t("active_hint", { paused: d.paused, new: d.new30 }));
  }
  if (type === "subs_churn") {
    const d = data as SubsChurnData;
    return tile(d.path, "subs-churn", d.rate === null ? "—" : formatPercent(d.rate, locale), t("churn_hint", { voluntary: d.voluntary, involuntary: d.involuntary }), (d.rate ?? 0) > 0.08);
  }
  const d = data as SubsAtRiskData;
  return tile(d.path, "subs-at-risk", formatMoney(d.valueAtRiskMinor, d.currency, locale), t("at_risk_hint", { n: d.count, failing: d.failing, high: d.highRisk }), d.count > 0);
}
