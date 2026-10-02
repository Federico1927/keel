"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banknote, Undo2 } from "lucide-react";
import { PAYMENT_METHODS, refundAmountForLines, type PaymentMethod } from "@keel/core";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@keel/ui";
import { recordPaymentAction, refundOrderAction } from "@/server/actions/payments";
import type { ActionResult } from "@/server/action-result";

function useMoney(currency: string, locale: string) {
  return useMemo(() => {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency });
    return (minor: number) => f.format(minor / 100);
  }, [currency, locale]);
}
const toMinor = (raw: string) => Math.round((Number(raw.replace(",", ".")) || 0) * 100);
const toRaw = (minor: number) => (minor / 100).toFixed(2);

function ErrorAlert({ result }: { result: ActionResult<unknown> | null }) {
  const tc = useTranslations("common");
  if (!result || result.ok) return null;
  return (
    <Alert variant="destructive" data-testid="payment-error">
      <AlertDescription>{tc(`errors.${result.error}`)}{result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : ""}</AlertDescription>
    </Alert>
  );
}

/** Mark as paid / record a manual payment on an order whose payment is pending (any method). */
export function RecordPaymentDialog({ slug, orderId, orderName, outstandingMinor, defaultMethod, today, currency, locale }: { slug: string; orderId: string; orderName: string; outstandingMinor: number; defaultMethod: string; today: string; currency: string; locale: string }) {
  const t = useTranslations("order_payments");
  const tc = useTranslations("common");
  const tp = useTranslations("payment_methods");
  const router = useRouter();
  const money = useMoney(currency, locale);
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(toRaw(outstandingMinor));
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>((PAYMENT_METHODS as readonly string[]).includes(defaultMethod) ? (defaultMethod as PaymentMethod) : "bank_transfer");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ fullyPaid: boolean; outstandingMinor: number }> | null>(null);
  const amount = toMinor(raw);
  const tooMuch = amount > outstandingMinor;
  return (
    <>
      <Button variant="outline" onClick={() => { setResult(null); setRaw(toRaw(outstandingMinor)); setOpen(true); }} data-testid="record-payment">
        <Banknote /> {t("mark_paid")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("payment_title", { order: orderName })}</DialogTitle>
            <DialogDescription>{t("payment_description", { amount: money(outstandingMinor) })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="p-amount">{t("amount", { currency })}</Label>
              <Input id="p-amount" inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="payment-amount" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-date">{t("date")}</Label>
              <Input id="p-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="p-method">{t("method")}</Label>
              <Select id="p-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{tp(m)}</option>)}
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="p-note">{t("note")}</Label>
              <Textarea id="p-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} placeholder={t("note_placeholder")} />
            </div>
            <p className="text-muted-foreground sm:col-span-2" data-testid="payment-preview">{amount >= outstandingMinor && !tooMuch ? t("preview_paid") : t("preview_partial", { rest: money(Math.max(0, outstandingMinor - amount)) })}</p>
            {tooMuch && <p className="text-destructive sm:col-span-2">{tc("errors.exceeds_outstanding")}</p>}
            <div className="sm:col-span-2"><ErrorAlert result={result} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              disabled={pending || amount <= 0 || tooMuch || !date}
              data-testid="payment-save"
              onClick={() =>
                start(async () => {
                  const r = await recordPaymentAction(slug, { orderId, amountMinor: amount, occurredAt: date, method, note: note.trim() || null });
                  setResult(r);
                  if (r.ok) {
                    setOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              {t("save_payment")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface RefundDialogLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  currentQuantity: number;
  refundedQuantity: number;
  unitPriceMinor: number;
}

/** Partial refund from the order page: an amount (≤ what remains refundable), optionally on lines with restock. */
export function RefundDialog({ slug, orderId, orderName, refundableMinor, order, lines, locations, currency, locale }: { slug: string; orderId: string; orderName: string; refundableMinor: number; order: { paymentStatus: string; totalMinor: number; refundedMinor: number; subtotalMinor: number; discountMinor: number }; lines: RefundDialogLine[]; locations: { id: string; name: string; isDefault: boolean }[]; currency: string; locale: string }) {
  const t = useTranslations("order_payments");
  const tc = useTranslations("common");
  const router = useRouter();
  const money = useMoney(currency, locale);
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(false);
  const [locationId, setLocationId] = useState(locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ amountMinor: number; requestedMinor: number; refundedMinor: number }> | null>(null);
  const amount = toMinor(raw);
  const tooMuch = amount > refundableMinor;
  const requests = Object.entries(qty).filter(([, q]) => q > 0).map(([orderLineId, quantity]) => ({ orderLineId, quantity }));
  const setLine = (id: string, q: number) => {
    const next = { ...qty, [id]: q };
    setQty(next);
    // the amount follows the units picked; it stays editable (goodwill on top, or less)
    const picked = Object.entries(next).filter(([, n]) => n > 0).map(([orderLineId, quantity]) => ({ orderLineId, quantity }));
    if (picked.length) setRaw(toRaw(refundAmountForLines(order, lines, picked)));
  };
  return (
    <>
      <Button variant="outline" onClick={() => { setResult(null); setRaw(""); setQty({}); setRestock(false); setNote(""); setRequestId(crypto.randomUUID()); setOpen(true); }} data-testid="refund-order">
        <Undo2 /> {t("refund")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("refund_title", { order: orderName })}</DialogTitle>
            <DialogDescription>{t("refund_description", { amount: money(refundableMinor) })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {lines.some((l) => l.currentQuantity - l.refundedQuantity > 0) && (
              <div className="space-y-1.5">
                <p className="font-medium">{t("lines")}</p>
                <ul className="divide-y rounded-md border">
                  {lines.filter((l) => l.currentQuantity - l.refundedQuantity > 0).map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 p-2">
                      <span className="min-w-0">
                        <span className="block truncate">{l.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{[l.variantTitle, l.sku, money(l.unitPriceMinor)].filter(Boolean).join(" · ")}</span>
                      </span>
                      <Input aria-label={t("line_qty", { item: l.title })} type="number" min={0} max={l.currentQuantity - l.refundedQuantity} value={qty[l.id] ?? 0} onChange={(e) => setLine(l.id, Math.max(0, Math.min(l.currentQuantity - l.refundedQuantity, Math.round(Number(e.target.value) || 0))))} className="w-20" data-testid="refund-line-qty" />
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t("lines_hint")}</p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="r-amount">{t("amount", { currency })}</Label>
                <Input id="r-amount" inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="refund-amount" />
              </div>
              {requests.length > 0 && locations.length > 0 && (
                <div className="space-y-1">
                  <label className="flex items-center gap-2 pt-6"><Checkbox checked={restock} onCheckedChange={(v) => setRestock(v === true)} data-testid="refund-restock" /> {t("restock")}</label>
                  {restock && (
                    <Select aria-label={t("location")} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="r-note">{t("reason")}</Label>
              <Textarea id="r-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} placeholder={t("reason_placeholder")} />
            </div>
            <label className="flex items-center gap-2"><Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} /> {t("notify")}</label>
            {tooMuch && <p className="text-destructive" data-testid="refund-too-much">{t("too_much", { amount: money(refundableMinor) })}</p>}
            {amount > 0 && !tooMuch && <p className="text-muted-foreground" data-testid="refund-preview">{t("refund_preview", { amount: money(amount), left: money(refundableMinor - amount) })}</p>}
            <ErrorAlert result={result} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              variant="destructive"
              disabled={pending || amount <= 0}
              data-testid="refund-save"
              onClick={() =>
                start(async () => {
                  const r = await refundOrderAction(slug, { orderId, amountMinor: amount, lines: requests, restock: restock && requests.length > 0, locationId: restock && locationId ? locationId : null, note: note.trim() || null, notify, requestId });
                  setResult(r);
                  if (r.ok) {
                    setOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              {t("refund_save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
