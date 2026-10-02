"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, cn } from "@keel/ui";
import { createDiscountCodeAction, createDiscountPoolAction } from "@/server/actions/discounts";

export function DiscountForms({ slug, currency, defaultPrefix }: { slug: string; currency: string; defaultPrefix: string }) {
  const t = useTranslations("discount_new");
  const tc = useTranslations("common");
  const router = useRouter();
  const [tab, setTab] = useState<"single" | "pool">("single");
  const [codeState, codeAction, codePending] = useActionState(createDiscountCodeAction.bind(null, slug), null);
  const [poolState, poolAction, poolPending] = useActionState(createDiscountPoolAction.bind(null, slug), null);
  const [type, setType] = useState("percentage");
  const [poolType, setPoolType] = useState("percentage");
  useEffect(() => {
    if (codeState?.ok && codeState.data) router.push(`/t/${slug}/discounts/${codeState.data.id}`);
  }, [codeState, router, slug]);
  useEffect(() => {
    if (poolState?.ok && poolState.data) router.push(`/t/${slug}/discounts/pools/${poolState.data.poolId}`);
  }, [poolState, router, slug]);
  const err = (s: { ok: boolean; error?: string } | null) => s && !s.ok && (tc.has(`errors.${s.error}`) ? tc(`errors.${s.error}`) : t(`errors.${s.error}`));
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">
        {(["single", "pool"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("flex-1 rounded-sm px-3 py-1.5", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`tabs.${k}`)}</button>
        ))}
      </div>
      {tab === "single" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("single_title")}</CardTitle>
            <CardDescription>{t("single_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={codeAction} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="d-code">{t("code")}</Label>
                <Input id="d-code" name="code" required maxLength={40} className="font-mono uppercase" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-title">{t("title_field")}</Label>
                <Input id="d-title" name="title" required maxLength={120} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-type">{t("type")}</Label>
                <Select id="d-type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="percentage">{t("types.percentage")}</option>
                  <option value="fixed_amount">{t("types.fixed_amount")}</option>
                  <option value="free_shipping">{t("types.free_shipping")}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-value">{type === "percentage" ? t("value_pct") : type === "fixed_amount" ? t("value_amount", { currency }) : t("value_na")}</Label>
                <Input id="d-value" name="value" type="number" step="0.01" min={0} defaultValue={type === "free_shipping" ? 0 : 10} disabled={type === "free_shipping"} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-starts">{t("starts_at")}</Label>
                <Input id="d-starts" name="startsAt" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-ends">{t("ends_at")}</Label>
                <Input id="d-ends" name="endsAt" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-limit">{t("usage_limit")}</Label>
                <Input id="d-limit" name="usageLimit" type="number" min={1} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-min">{t("minimum", { currency })}</Label>
                <Input id="d-min" name="minimumAmount" type="number" step="0.01" min={0} />
              </div>
              {err(codeState) && (
                <Alert variant="destructive" className="sm:col-span-2">
                  <AlertDescription>{err(codeState)}</AlertDescription>
                </Alert>
              )}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={codePending}>{t("create_code")}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("pool_title")}</CardTitle>
            <CardDescription>{t("pool_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={poolAction} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="p-title">{t("title_field")}</Label>
                <Input id="p-title" name="title" required maxLength={120} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-prefix">{t("prefix")}</Label>
                <Input id="p-prefix" name="prefix" required maxLength={12} defaultValue={defaultPrefix} className="font-mono uppercase" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-size">{t("size")}</Label>
                <Input id="p-size" name="size" type="number" min={1} max={10000} defaultValue={100} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-type">{t("type")}</Label>
                <Select id="p-type" name="type" value={poolType} onChange={(e) => setPoolType(e.target.value)}>
                  <option value="percentage">{t("types.percentage")}</option>
                  <option value="fixed_amount">{t("types.fixed_amount")}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-value">{poolType === "percentage" ? t("value_pct") : t("value_amount", { currency })}</Label>
                <Input id="p-value" name="value" type="number" step="0.01" min={0} defaultValue={15} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-starts">{t("starts_at")}</Label>
                <Input id="p-starts" name="startsAt" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-ends">{t("ends_at")}</Label>
                <Input id="p-ends" name="endsAt" type="date" />
              </div>
              {err(poolState) && (
                <Alert variant="destructive" className="sm:col-span-2">
                  <AlertDescription>{err(poolState)}</AlertDescription>
                </Alert>
              )}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={poolPending}>{t("create_pool")}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
