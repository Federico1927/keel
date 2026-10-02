"use client";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@hullwise/ui";
import { toggleRepurchasable } from "@/server/actions/catalog";

/** Hullwise-only product flag (not a platform field): whether the product is bought again from suppliers. */
export function ProductActions({ slug, productId, isRepurchasable }: { slug: string; productId: string; isRepurchasable: boolean }) {
  const t = useTranslations("product_detail");
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={isRepurchasable} disabled={pending} onCheckedChange={(v) => start(() => void toggleRepurchasable(slug, productId, v))} /> {t("repurchasable")}
    </label>
  );
}
