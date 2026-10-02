"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import { formatMoney } from "@hullwise/core";
import { createReturnAction } from "@/server/actions/returns";
import type { ActionResult } from "@/server/action-result";

export interface NewReturnLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  returnable: number;
  alreadyReturned: number;
  unitNetMinor: number;
  excluded: boolean;
  /** Why the line cannot be returned now (policy exclusion, final sale, expired). */
  block: string | null;
  maxQuantity: number;
  deadline: string | null;
  exchangeOptions: { variantId: string; title: string; priceMinor: number }[];
}

export function NewReturnForm({ slug, orderId, lines, reasons, eligible, eligibilityReason, currency, locale }: { slug: string; orderId: string; lines: NewReturnLine[]; reasons: { code: string; label: string }[]; eligible: boolean; eligibilityReason: string | null; currency: string; locale: string }) {
  const t = useTranslations("return_new");
  const tr = useTranslations("returns");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, 0])));
  const [reason, setReason] = useState(reasons[0]?.code ?? "");
  const [resolution, setResolution] = useState<"refund" | "exchange" | "voucher">("refund");
  const [customerNote, setCustomerNote] = useState("");
  const [staffNote, setStaffNote] = useState("");
  const [result, setResult] = useState<ActionResult<{ id: string }> | null>(null);
  const total = useMemo(() => lines.reduce((s, l) => s + (qty[l.id] ?? 0) * l.unitNetMinor, 0), [lines, qty]);
  const anyQty = Object.values(qty).some((q) => q > 0);
  const anyBlocked = lines.some((l) => l.block !== null && l.maxQuantity > 0) || eligibilityReason === "customer_limit";
  const blocked = !eligible && (eligibilityReason === "cancelled" || eligibilityReason === "not_delivered");
  const [override, setOverride] = useState(false);
  const [exchangeFor, setExchangeFor] = useState<Record<string, string>>({});
  const canOverride = override && anyBlocked;
  const maxFor = (l: NewReturnLine) => (canOverride ? l.maxQuantity : l.returnable);
  return (
    <form
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createReturnAction(slug, { orderId, reasonCode: reason, resolution, lines: lines.map((l) => ({ orderLineId: l.id, quantity: qty[l.id] ?? 0 })), customerNote: customerNote || null, staffNote: staffNote || null, overrideWindow: canOverride, exchangeLines: resolution === "exchange" ? lines.filter((l) => (qty[l.id] ?? 0) > 0 && exchangeFor[l.id]).map((l) => ({ orderLineId: l.id, variantId: exchangeFor[l.id]!, quantity: qty[l.id]! })) : undefined });
          setResult(r);
          if (r.ok && r.data) router.push(`/t/${slug}/returns/${r.data.id}`);
        });
      }}
    >
      <div className="space-y-4">
        {!eligible && (
          <Alert variant={blocked ? "destructive" : "default"}>
            <AlertDescription>{t(`not_eligible.${eligibilityReason ?? "not_delivered"}`)}{anyBlocked && !blocked ? ` ${t("override_hint")}` : ""}</AlertDescription>
          </Alert>
        )}
        {anyBlocked && !blocked && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="return-override" /> {t("override_label")}
          </label>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("lines_title")}</CardTitle>
            <CardDescription>{t("lines_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 rounded-md border p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{[l.variantTitle, l.sku].filter(Boolean).join(" · ")} · {t("ordered", { n: l.quantity })}{l.alreadyReturned ? ` · ${t("already", { n: l.alreadyReturned })}` : ""}{l.block ? <span className="text-warning"> · {t(`blocks.${l.block}`)}</span> : ""}</div>
                </div>
                <div className="text-right tabular">{formatMoney(l.unitNetMinor, currency, locale)}</div>
                {resolution === "exchange" && (qty[l.id] ?? 0) > 0 && l.exchangeOptions.length > 0 && (
                  <Select size="sm" aria-label={t("exchange_for", { title: l.title })} wrapperClassName="col-span-3" value={exchangeFor[l.id] ?? ""} onChange={(e) => setExchangeFor({ ...exchangeFor, [l.id]: e.target.value })} data-testid="exchange-variant">
                    <option value="">{t("exchange_none")}</option>
                    {l.exchangeOptions.map((o) => <option key={o.variantId} value={o.variantId}>{o.title} · {formatMoney(o.priceMinor, currency, locale)}</option>)}
                  </Select>
                )}
                <Input size="sm" type="number" min={0} max={maxFor(l)} value={qty[l.id] ?? 0} disabled={maxFor(l) === 0 || blocked} onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(maxFor(l), Number(e.target.value) || 0)) })} aria-label={t("qty_for", { title: l.title })} />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="return-reason">{tr("columns.reason")}</Label>
              <Select id="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={blocked}>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="return-resolution">{tr("columns.resolution")}</Label>
              <Select id="return-resolution" value={resolution} onChange={(e) => setResolution(e.target.value as "refund" | "exchange" | "voucher")} disabled={blocked}>
                {(["refund", "exchange", "voucher"] as const).map((r) => (
                  <option key={r} value={r}>{tr(`resolution.${r}`)}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="customer-note">{t("customer_note")}</Label>
              <Textarea id="customer-note" rows={2} value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} disabled={blocked} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="staff-note">{canOverride ? t("staff_note_required") : t("staff_note")}</Label>
              <Textarea id="staff-note" rows={2} value={staffNote} onChange={(e) => setStaffNote(e.target.value)} disabled={blocked} />
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit">
        <CardHeader><CardTitle className="text-base">{t("summary")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="flex justify-between"><span>{t("items")}</span><span className="tabular">{Object.values(qty).reduce((s, q) => s + q, 0)}</span></p>
          <p className="flex justify-between font-medium"><span>{t("proposed")}</span><span className="tabular">{formatMoney(total, currency, locale)}</span></p>
          {result && !result.ok && <p className="text-destructive">{tc.has(`errors.${result.error}`) ? tc(`errors.${result.error}`) : t(`errors.${result.error}`)}</p>}
          <Button type="submit" className="w-full" disabled={pending || blocked || !anyQty || !reason || (canOverride && !staffNote.trim())}>{t("submit")}</Button>
        </CardContent>
      </Card>
    </form>
  );
}
