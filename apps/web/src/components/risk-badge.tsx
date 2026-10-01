"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@keel/ui";

export function RiskBadge({ risk, days }: { risk: string; days?: number | null }) {
  const t = useTranslations("stock_risk");
  const variant = risk === "critical" ? "destructive" : risk === "warning" ? "warning" : risk === "ok" ? "success" : "muted";
  return (
    <Badge variant={variant}>
      {t(risk)}
      {days !== null && days !== undefined && Number.isFinite(days) && <span className="ml-1 tabular opacity-80">{Math.round(days)}d</span>}
    </Badge>
  );
}
