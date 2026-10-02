"use client";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Checkbox, DataList, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, ScanButton, Select, Stepper } from "@hullwise/ui";
import { matchScanCode } from "@hullwise/core";
import { scanLabels } from "@/components/scan-labels";
import { addSupplierPayment, receivePo, transitionPo } from "@/server/actions/purchasing";

export function PoActions({ slug, poId, status, transitions, supplierId, balanceMinor }: { slug: string; poId: string; status: string; transitions: readonly string[]; supplierId: string; balanceMinor: number }) {
  const t = useTranslations("po_detail");
  const tps = useTranslations("po_status");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [payOpen, setPayOpen] = useState(false);
  const [payState, payAction, payPending] = useActionState(addSupplierPayment.bind(null, slug), null);
  const visible = transitions.filter((x) => x !== "partially_received" && x !== "received");
  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((to) => (
        <Button key={to} variant={to === "cancelled" ? "destructive" : "outline"} disabled={pending} onClick={() => start(() => void transitionPo(slug, poId, to))}>
          {t("mark_as", { status: tps(to) })}
        </Button>
      ))}
      {status !== "draft" && status !== "cancelled" && balanceMinor > 0 && (
        <Button variant="secondary" onClick={() => setPayOpen(true)}>
          {t("record_payment")}
        </Button>
      )}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("record_payment")}</DialogTitle>
          </DialogHeader>
          <form action={payAction} className="space-y-3">
            <input type="hidden" name="supplierId" value={supplierId} />
            <input type="hidden" name="purchaseOrderId" value={poId} />
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">{t("amount")}</Label>
              <Input id="pay-amount" name="amount" type="number" step="0.01" min="0.01" defaultValue={(balanceMinor / 100).toFixed(2)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">{t("paid_on")}</Label>
              <Input id="pay-date" name="paidAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-method">{t("method")}</Label>
              <Select id="pay-method" name="method" defaultValue="bank_transfer">
                <option value="bank_transfer">{t("methods.bank_transfer")}</option>
                <option value="card">{t("methods.card")}</option>
                <option value="other">{t("methods.other")}</option>
              </Select>
            </div>
            {payState && !payState.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${payState.error}`)}</AlertDescription></Alert>}
            {payState?.ok && <Alert variant="info"><AlertDescription>{tc("saved")}</AlertDescription></Alert>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPayOpen(false)}>{tc("cancel")}</Button>
              <Button type="submit" disabled={payPending}>{tc("save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ReceiveForm({ slug, poId, locations, defaultLocationId, lines }: { slug: string; poId: string; locations: { id: string; name: string; isDefault: boolean }[]; defaultLocationId: string | null; lines: { id: string; label: string; sku: string | null; codes?: (string | null)[]; quantity: number; receivedQuantity: number; damagedQuantity: number; rejectedQuantity: number; unitCost: string }[] }) {
  const t = useTranslations("po_detail");
  const tc = useTranslations("common");
  const tm = useTranslations("mobile.scan");
  const ts = useTranslations("mobile.stepper");
  const [state, action, pending] = useActionState(receivePo.bind(null, slug, poId), null);
  const remainingOf = (l: (typeof lines)[number]) => l.quantity - l.receivedQuantity;
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(lines.map((l) => [l.id, remainingOf(l)])));
  // scanning counts what is in the box: the first scan of a line starts it from 1 (#49)
  const [scanCounts, setScanCounts] = useState<Record<string, number>>({});
  const [scanned, setScanned] = useState<{ ok: boolean; text: string } | null>(null);
  const onScan = (code: string) => {
    const hit = matchScanCode(code, lines.map((l) => ({ ...l, codes: l.codes ?? [l.sku], open: (scanCounts[l.id] ?? 0) < remainingOf(l) })));
    if (!hit || remainingOf(hit) === 0) return setScanned({ ok: false, text: t("scan_no_match", { code }) });
    const n = Math.min(remainingOf(hit), (scanCounts[hit.id] ?? 0) + 1);
    setScanCounts((c) => ({ ...c, [hit.id]: n }));
    setQty((q) => ({ ...q, [hit.id]: n }));
    setScanned({ ok: true, text: t("scan_counted", { item: hit.label, n, of: remainingOf(hit) }) });
  };
  return (
    <form action={action}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <p className="text-sm text-muted-foreground">{t("scan_hint")}</p>
        <ScanButton size="sm" continuous labels={scanLabels(tm)} onScan={onScan} />
        {scanned && <p className={scanned.ok ? "w-full text-sm text-success" : "w-full text-sm text-warning"} role="status" data-testid="po-scan-result">{scanned.text}</p>}
      </div>
      <DataList
        rows={lines}
        rowKey={(l) => l.id}
        rowProps={(l) => ({ "data-testid": "receive-line", className: scanCounts[l.id] ? "bg-success/5" : undefined })}
        columns={[
          { key: "item", header: t("line.item"), mobile: "title", cell: (l) => <><p className="font-medium">{l.label}</p><p className="text-xs font-normal text-muted-foreground">{l.sku}</p></> },
          { key: "ordered", header: t("line.ordered"), align: "right", className: "tabular", cell: (l) => l.quantity },
          { key: "received", header: t("line.received"), align: "right", className: "tabular", cell: (l) => <>{l.receivedQuantity}{l.damagedQuantity + l.rejectedQuantity > 0 && <span className="block text-xs text-destructive max-md:ml-1 max-md:inline">{t("inspection.short", { damaged: l.damagedQuantity, rejected: l.rejectedQuantity })}</span>}</> },
          { key: "cost", header: t("line.unit_cost"), align: "right", className: "tabular", cell: (l) => l.unitCost },
          {
            key: "now",
            header: t("line.receive_now"),
            mobile: "action",
            align: "right",
            cell: (l) => (
              <label className="flex items-center justify-between gap-2 md:justify-end">
                <span className="text-xs text-muted-foreground md:sr-only">{t("line.receive_now")}</span>
                <Stepper size="sm" name={`qty_${l.id}`} min={0} max={remainingOf(l)} value={qty[l.id] ?? 0} onValueChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))} disabled={remainingOf(l) === 0} decrementLabel={ts("decrement")} incrementLabel={ts("increment")} aria-label={t("line.receive_now")} />
              </label>
            ),
          },
          { key: "damaged", header: t("inspection.damaged"), mobile: "action", align: "right", className: "max-md:basis-[calc(50%-0.375rem)]", cell: (l) => <label className="flex items-center gap-2 md:justify-end"><span className="text-xs text-muted-foreground md:sr-only">{t("inspection.damaged")}</span><Input size="sm" name={`dmg_${l.id}`} type="number" min={0} max={remainingOf(l)} defaultValue={0} className="w-16 text-right max-md:ml-auto" aria-label={t("inspection.damaged")} disabled={remainingOf(l) === 0} /></label> },
          { key: "rejected", header: t("inspection.rejected"), mobile: "action", align: "right", className: "max-md:basis-[calc(50%-0.375rem)]", cell: (l) => <label className="flex items-center gap-2 md:justify-end"><span className="text-xs text-muted-foreground md:sr-only">{t("inspection.rejected")}</span><Input size="sm" name={`rej_${l.id}`} type="number" min={0} max={remainingOf(l)} defaultValue={0} className="w-16 text-right max-md:ml-auto" aria-label={t("inspection.rejected")} disabled={remainingOf(l) === 0} /></label> },
        ]}
      />
      <p className="border-t px-4 pt-3 text-xs text-muted-foreground">{t("inspection.hint")}</p>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="receive-location">{t("receive_into")}</Label>
            <Select id="receive-location" name="locationId" defaultValue={defaultLocationId ?? locations.find((l) => l.isDefault)?.id ?? ""} className="w-56">
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox name="pushToPlatform" /> {t("push_to_platform")}
          </label>
        </div>
        <div className="flex items-center gap-3">
          {state && !state.ok && <span className="text-sm text-destructive">{tc(`errors.${state.error}`)}</span>}
          {state?.ok && <span className="text-sm text-success">{t("received_ok", { released: state.data?.released ?? 0 })}</span>}
          <Button type="submit" disabled={pending} className="max-sm:w-full">{t("receive")}</Button>
        </div>
      </div>
    </form>
  );
}
