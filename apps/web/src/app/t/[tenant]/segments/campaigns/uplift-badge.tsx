"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@hullwise/ui";
import type { CampaignResults } from "@hullwise/services";

/** One-word verdict on a campaign: measured uplift, no effect, still running, or not measurable. */
export function UpliftBadge({ results, locale }: { results: CampaignResults | null; locale: string }) {
  const t = useTranslations("retention");
  if (!results) return <span className="text-muted-foreground">—</span>;
  const r = results.report;
  if (!r.measurable) return <Badge variant="muted">{t("verdict.no_control")}</Badge>;
  const pts = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "always" }).format((r.conversion?.diff ?? 0) * 100);
  if (results.windowOpen) return <Badge variant="info">{t("verdict.running", { pts })}</Badge>;
  if (!r.significant) return <Badge variant="secondary">{t("verdict.inconclusive", { pts })}</Badge>;
  return <Badge variant={(r.conversion?.diff ?? 0) > 0 ? "success" : "destructive"}>{t("verdict.significant", { pts })}</Badge>;
}
