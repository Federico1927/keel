"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@keel/ui";

export function LightBadge({ light }: { light: string }) {
  const t = useTranslations("campaigns");
  const variant = light === "good" ? "success" : light === "medium" ? "warning" : light === "bad" ? "destructive" : "muted";
  return <Badge variant={variant}>{t(`light.${light}`)}</Badge>;
}

export function ActionBadge({ action }: { action: string }) {
  const t = useTranslations("campaigns");
  const variant = action === "ok" ? "muted" : action.startsWith("pause") ? "destructive" : action === "resume" ? "success" : "warning";
  return <Badge variant={variant}>{t(`action.${action}`)}</Badge>;
}
