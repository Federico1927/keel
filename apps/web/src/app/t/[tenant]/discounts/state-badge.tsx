"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@hullwise/ui";

const VARIANT: Record<string, "success" | "info" | "muted" | "warning" | "destructive"> = { active: "success", scheduled: "info", expired: "muted", exhausted: "warning", disabled: "destructive" };
export function DiscountStateBadge({ state }: { state: string }) {
  const t = useTranslations("discounts");
  return <Badge variant={VARIANT[state] ?? "muted"}>{t(`state.${state}`)}</Badge>;
}
