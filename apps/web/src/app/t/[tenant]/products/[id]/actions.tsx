"use client";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Select, Switch } from "@keel/ui";
import { toggleRepurchasable, updateProductStatus, updateVariantPrice } from "@/server/actions/catalog";

export function ProductActions({ slug, productId, status, isRepurchasable }: { slug: string; productId: string; status: string; isRepurchasable: boolean }) {
  const t = useTranslations("product_detail");
  const tp = useTranslations("products");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={isRepurchasable} disabled={pending} onCheckedChange={(v) => start(() => void toggleRepurchasable(slug, productId, v))} /> {t("repurchasable")}
      </label>
      <Select aria-label={t("platform_status")} value={status} disabled={pending} className="w-40" onChange={(e) => start(() => void updateProductStatus(slug, productId, e.target.value))}>
        {["active", "draft", "archived"].map((s) => (
          <option key={s} value={s}>{tp(`status.${s}`)}</option>
        ))}
      </Select>
    </div>
  );
}

export function VariantPriceForm({ slug, variantId, price }: { slug: string; variantId: string; price: number }) {
  const t = useTranslations("product_detail");
  const [state, action, pending] = useActionState(updateVariantPrice.bind(null, slug), null);
  const [value, setValue] = useState(price.toFixed(2));
  return (
    <form action={action} className="inline-flex items-center justify-end gap-1">
      <input type="hidden" name="variantId" value={variantId} />
      <Input size="sm" name="price" type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} className="w-24 text-right" aria-label={t("variant.price")} />
      {Number(value) !== price && (
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {t("save_price")}
        </Button>
      )}
      {state && !state.ok && <span className="text-xs text-destructive">!</span>}
    </form>
  );
}
