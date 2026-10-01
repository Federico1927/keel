"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Percent } from "lucide-react";
import { orderDiscountAmount, type OrderAmounts, type OrderDiscountKind } from "@keel/core";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select } from "@keel/ui";
import { applyOrderDiscountAction } from "@/server/actions/orders";
import type { ActionResult } from "@/server/action-result";

/** Preset or custom discount (% or amount) on an open order, written to the store through the adapter. */
export function DiscountOrderDialog({ slug, orderId, orderName, amounts, presetsBps, paid, currency, locale }: { slug: string; orderId: string; orderName: string; amounts: OrderAmounts; presetsBps: readonly number[]; paid: boolean; currency: string; locale: string }) {
  const t = useTranslations("order_discount");
  const tc = useTranslations("common");
  const router = useRouter();
  const money = useMemo(() => {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency });
    return (minor: number) => f.format(minor / 100);
  }, [currency, locale]);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<OrderDiscountKind>("percentage");
  const [raw, setRaw] = useState("10");
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ code: string; amountMinor: number; refundDueMinor: number }> | null>(null);
  // percentages travel in basis points, amounts in minor units
  const value = Math.round((Number(raw.replace(",", ".")) || 0) * 100);
  const amount = orderDiscountAmount(amounts, { type, value });
  return (
    <>
      <Button variant="outline" onClick={() => { setResult(null); setOpen(true); }} data-testid="apply-discount">
        <Percent /> {t("button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title", { order: orderName })}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium">{t("presets")}</p>
              <div className="flex flex-wrap gap-2">
                {presetsBps.map((bps) => (
                  <Button key={bps} type="button" size="sm" variant={type === "percentage" && value === bps ? "default" : "outline"} onClick={() => { setType("percentage"); setRaw(String(bps / 100)); }} data-testid={`discount-preset-${bps}`}>
                    {bps / 100}%
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="d-type">{t("type")}</Label>
                <Select id="d-type" value={type} onChange={(e) => setType(e.target.value as OrderDiscountKind)}>
                  <option value="percentage">{t("type_percentage")}</option>
                  <option value="fixed_amount">{t("type_fixed_amount", { currency })}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-value">{t("value")}</Label>
                <Input id="d-value" inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-code">{t("code")}</Label>
                <Input id="d-code" value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-reason">{t("reason")}</Label>
                <Input id="d-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </div>
            </div>
            <p className="text-muted-foreground" data-testid="discount-preview">{t("preview", { amount: money(amount), total: money(Math.max(0, amounts.totalMinor - amount)) })}</p>
            {paid && amount > 0 && <Alert><AlertDescription>{t("refund_due", { amount: money(amount) })}</AlertDescription></Alert>}
            {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}{result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : ""}</AlertDescription></Alert>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              disabled={pending || amount <= 0}
              data-testid="discount-save"
              onClick={() =>
                start(async () => {
                  const r = await applyOrderDiscountAction(slug, { orderId, type, value, code: code.trim() || null, reason: reason.trim() || null });
                  setResult(r);
                  if (r.ok) {
                    setOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              {t("apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
