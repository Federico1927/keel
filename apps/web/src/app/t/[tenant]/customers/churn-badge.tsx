"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@keel/ui";

const VARIANT: Record<string, "success" | "warning" | "destructive"> = { low: "success", medium: "warning", high: "destructive" };

export function ChurnBadge({ risk }: { risk: string | null | undefined }) {
  const t = useTranslations("predictions");
  if (!risk) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={VARIANT[risk] ?? "outline"}>{t(`risk.${risk}`)}</Badge>;
}
