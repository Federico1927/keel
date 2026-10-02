"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@hullwise/ui";

const VARIANT: Record<string, "success" | "default" | "info" | "warning" | "destructive" | "muted" | "secondary"> = { champions: "success", loyal: "default", promising: "info", new: "info", at_risk: "warning", one_time: "secondary", dormant: "muted", lost: "destructive" };

export function TierBadge({ tier }: { tier: string | null }) {
  const t = useTranslations("rfm");
  if (!tier) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={VARIANT[tier] ?? "outline"}>{t(`tier.${tier}`)}</Badge>;
}
