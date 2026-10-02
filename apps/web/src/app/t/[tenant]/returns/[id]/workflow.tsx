"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import { RETURN_TRANSITIONS, formatMoney, type ReturnStatus } from "@hullwise/core";
import { transitionReturnAction } from "@/server/actions/returns";
import type { ActionResult } from "@/server/action-result";

export interface WorkflowLine {
  id: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  unitAmountMinor: number;
  restocked: boolean;
  inspectionAmountMinor: number | null;
  hasVariant: boolean;
}

export function ReturnWorkflow({ slug, returnId, status, resolution, lines, locations, proposedAmountMinor, currency, locale, canAct }: { slug: string; returnId: string; status: string; resolution: string; lines: WorkflowLine[]; locations: { id: string; name: string; isDefault: boolean }[]; proposedAmountMinor: number; currency: string; locale: string; canAct: boolean }) {
  const t = useTranslations("return_detail");
  const ts = useTranslations("return_status");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<ReturnStatus | null>(null);
  const [note, setNote] = useState("");
  const [restock, setRestock] = useState(true);
  const [locationId, setLocationId] = useState(locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>(lines.filter((l) => !l.restocked && l.hasVariant).map((l) => l.id));
  const [inspection, setInspection] = useState<Record<string, { outcome: "intact" | "damaged" | "missing"; amount: number }>>(Object.fromEntries(lines.map((l) => [l.id, { outcome: "intact", amount: (l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor) / 100 }])));
  const [refund, setRefund] = useState(lines.reduce((s, l) => s + (l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor), 0) / 100);
  const [voucher, setVoucher] = useState("");
  const [fault, setFault] = useState("");
  const [result, setResult] = useState<ActionResult<{ next: string; sync: string }> | null>(null);
  if (!canAct) return null;
  const next = RETURN_TRANSITIONS[status as ReturnStatus] ?? [];
  const closers: ReturnStatus[] = ["refunded", "exchanged", "voucher_issued"];
  const preferredCloser: ReturnStatus = resolution === "exchange" ? "exchanged" : resolution === "voucher" ? "voucher_issued" : "refunded";
  const ordered = [...next].sort((a, b) => (a === preferredCloser ? -1 : b === preferredCloser ? 1 : a === "rejected" ? 1 : b === "rejected" ? -1 : 0));
  const submit = () =>
    start(async () => {
      if (!target) return;
      const r = await transitionReturnAction(slug, returnId, {
        to: target,
        note: note || null,
        fault: fault || undefined,
        restock: target === "received" && restock ? { locationId, lineIds: selected } : null,
        inspection: target === "inspected" ? lines.map((l) => ({ lineId: l.id, outcome: inspection[l.id]!.outcome, amountMinor: Math.round(inspection[l.id]!.amount * 100) })) : undefined,
        refundAmountMinor: target === "refunded" || target === "voucher_issued" ? Math.round(refund * 100) : null,
        voucherCode: target === "voucher_issued" ? voucher || null : null,
      });
      setResult(r);
      if (r.ok) {
        setTarget(null);
        setNote("");
        router.refresh();
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {result?.ok && result.data?.sync === "error" && (
        <Alert variant="warning" className="w-full" data-testid="return-sync-warning">
          <AlertDescription>{t("sync_failed")}</AlertDescription>
        </Alert>
      )}
      {result && !result.ok && (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{tc.has(`errors.${result.error}`) ? tc(`errors.${result.error}`) : t(`errors.${result.error}`)}</AlertDescription>
        </Alert>
      )}
      {ordered.map((s) => (
        <Button key={s} variant={s === "rejected" ? "destructive" : closers.includes(s) && s !== preferredCloser ? "outline" : "default"} disabled={pending} onClick={() => setTarget(s)}>
          {t(`actions.${s}`)}
        </Button>
      ))}
      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{target ? t(`dialog.${target}.title`) : ""}</DialogTitle>
            <DialogDescription>{target ? t(`dialog.${target}.description`) : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {target === "received" && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> {t("restock_label")}
                </label>
                {restock && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="restock-location">{t("restock_location")}</Label>
                      <Select id="restock-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </Select>
                    </div>
                    <ul className="space-y-1 text-sm">
                      {lines.map((l) => (
                        <li key={l.id} className="flex items-center gap-2">
                          <input type="checkbox" disabled={l.restocked || !l.hasVariant} checked={selected.includes(l.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))} />
                          <span className="min-w-0 flex-1 truncate">{l.title}{l.variantTitle ? ` · ${l.variantTitle}` : ""}</span>
                          <span className="tabular text-muted-foreground">× {l.quantity}</span>
                          {l.restocked && <span className="text-xs text-muted-foreground">{t("already_restocked")}</span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {target === "inspected" && (
              <div className="space-y-2">
                {lines.map((l) => (
                  <div key={l.id} className="grid grid-cols-[1fr_8rem_7rem] items-center gap-2 text-sm">
                    <span className="min-w-0 truncate">{l.title}{l.variantTitle ? ` · ${l.variantTitle}` : ""} × {l.quantity}</span>
                    <Select size="sm" value={inspection[l.id]!.outcome} onChange={(e) => setInspection({ ...inspection, [l.id]: { ...inspection[l.id]!, outcome: e.target.value as "intact" | "damaged" | "missing" } })} >
                      {(["intact", "damaged", "missing"] as const).map((o) => (
                        <option key={o} value={o}>{t(`outcome.${o}`)}</option>
                      ))}
                    </Select>
                    <Input size="sm" type="number" step="0.01" min={0} value={inspection[l.id]!.amount} onChange={(e) => setInspection({ ...inspection, [l.id]: { ...inspection[l.id]!, amount: Number(e.target.value) } })} aria-label={t("accepted_amount")} />
                  </div>
                ))}
                <div className="space-y-1">
                  <Label htmlFor="fault">{t("fault")}</Label>
                  <Select id="fault" value={fault} onChange={(e) => setFault(e.target.value)}>
                    <option value="">{t("fault_keep")}</option>
                    {(["merchant", "customer", "undetermined"] as const).map((f) => (
                      <option key={f} value={f}>{t(`faults.${f}`)}</option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            {(target === "refunded" || target === "voucher_issued") && (
              <div className="space-y-1">
                <Label htmlFor="refund-amount">{target === "refunded" ? t("refund_amount") : t("voucher_amount")}</Label>
                <Input id="refund-amount" type="number" step="0.01" min={0} value={refund} onChange={(e) => setRefund(Number(e.target.value))} />
                <p className="text-xs text-muted-foreground">{t("proposed", { amount: formatMoney(proposedAmountMinor, currency, locale) })}</p>
              </div>
            )}
            {target === "voucher_issued" && (
              <div className="space-y-1">
                <Label htmlFor="voucher-code">{t("voucher_code")}</Label>
                <Input id="voucher-code" value={voucher} onChange={(e) => setVoucher(e.target.value)} placeholder={t("voucher_auto")} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="transition-note">{target === "rejected" ? t("reject_note") : t("note_optional")}</Label>
              <Textarea id="transition-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>{tc("cancel")}</Button>
            <Button disabled={pending || (target === "rejected" && !note.trim())} variant={target === "rejected" ? "destructive" : "default"} onClick={submit}>{target ? t(`actions.${target}`) : ""}{target ? "" : ts("requested")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
