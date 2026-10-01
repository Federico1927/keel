"use client";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
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

export function ReceiveForm({ slug, poId, locations, defaultLocationId, lines }: { slug: string; poId: string; locations: { id: string; name: string; isDefault: boolean }[]; defaultLocationId: string | null; lines: { id: string; label: string; sku: string | null; quantity: number; receivedQuantity: number; unitCost: string }[] }) {
  const t = useTranslations("po_detail");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(receivePo.bind(null, slug, poId), null);
  return (
    <form action={action}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("line.item")}</TableHead>
            <TableHead className="text-right">{t("line.ordered")}</TableHead>
            <TableHead className="text-right">{t("line.received")}</TableHead>
            <TableHead className="text-right">{t("line.unit_cost")}</TableHead>
            <TableHead className="text-right">{t("line.receive_now")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => {
            const remaining = l.quantity - l.receivedQuantity;
            return (
              <TableRow key={l.id}>
                <TableCell>
                  <p className="font-medium">{l.label}</p>
                  <p className="text-xs text-muted-foreground">{l.sku}</p>
                </TableCell>
                <TableCell className="text-right tabular">{l.quantity}</TableCell>
                <TableCell className="text-right tabular">{l.receivedQuantity}</TableCell>
                <TableCell className="text-right tabular">{l.unitCost}</TableCell>
                <TableCell className="text-right">
                  <Input name={`qty_${l.id}`} type="number" min={0} max={remaining} defaultValue={remaining} className="ml-auto h-8 w-24 text-right" aria-label={t("line.receive_now")} disabled={remaining === 0} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-end sm:justify-between">
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
          <Button type="submit" disabled={pending}>{t("receive")}</Button>
        </div>
      </div>
    </form>
  );
}
