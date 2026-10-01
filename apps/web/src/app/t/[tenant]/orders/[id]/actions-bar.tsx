"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Ban, ChevronDown, RotateCcw, UserPlus } from "lucide-react";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Label, Select } from "@keel/ui";
import { ORDER_STATUSES } from "@keel/core";
import { assignOrder, cancelOrder, changeOrderStatus, resetOrderStatus } from "@/server/actions/orders";
import type { ActionResult } from "@/server/action-result";

const MANUAL_CHOICES = ORDER_STATUSES.filter((s) => !["cancelled", "returned", "returned_partial", "refunded", "delivered"].includes(s));

export function OrderActions({ slug, orderId, currentStatus, statusSource, cancelled, members, assignedTo, canCancel, canAssign }: { slug: string; orderId: string; currentStatus: string; statusSource: string; cancelled: boolean; members: { id: string; name: string }[]; assignedTo: string | null; canCancel: boolean; canAssign: boolean }) {
  const t = useTranslations("order_detail");
  const ts = useTranslations("order_status");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [statusOpen, setStatusOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [nextStatus, setNextStatus] = useState(currentStatus);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("customer");
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(true);
  const [assignee, setAssignee] = useState(assignedTo ?? "");

  const run = (fn: () => Promise<ActionResult>, close: () => void) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) close();
    });

  return (
    <>
      {result && !result.ok && (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{tc(`errors.${result.error}`) + (result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : "")}</AlertDescription>
        </Alert>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={pending || cancelled}>
            {t("change_status")} <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("set_status_to")}</DropdownMenuLabel>
          {MANUAL_CHOICES.map((s) => (
            <DropdownMenuItem key={s} disabled={s === currentStatus} onSelect={() => { setNextStatus(s); setStatusOpen(true); }}>
              {ts(s)}
            </DropdownMenuItem>
          ))}
          {statusSource === "manual" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => run(() => resetOrderStatus(slug, orderId), () => undefined)}>
                <RotateCcw /> {t("reset_status")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canAssign && (
        <Button variant="outline" disabled={pending} onClick={() => setAssignOpen(true)}>
          <UserPlus /> {t("assign")}
        </Button>
      )}
      {canCancel && !cancelled && (
        <Button variant="destructive" disabled={pending} onClick={() => setCancelOpen(true)}>
          <Ban /> {t("cancel_order")}
        </Button>
      )}

      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("status_dialog_title", { status: ts(nextStatus) })}</DialogTitle>
            <DialogDescription>{t("status_dialog_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="status-note">{t("note_optional")}</Label>
            <Input id="status-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStatusOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} onClick={() => run(() => changeOrderStatus(slug, orderId, nextStatus, note || undefined), () => setStatusOpen(false))}>{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cancel_dialog_title")}</DialogTitle>
            <DialogDescription>{t("cancel_dialog_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reason">{t("cancel_reason")}</Label>
              <Select id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                {["customer", "inventory", "fraud", "declined", "other"].map((r) => (
                  <option key={r} value={r}>{t(`cancel_reasons.${r}`)}</option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={restock} onCheckedChange={(v) => setRestock(Boolean(v))} /> {t("restock")}</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={refund} onCheckedChange={(v) => setRefund(Boolean(v))} /> {t("refund")}</label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>{tc("cancel")}</Button>
            <Button variant="destructive" disabled={pending} onClick={() => run(() => cancelOrder(slug, orderId, { reason, restock, refund }), () => setCancelOpen(false))}>{t("cancel_order")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("assign")}</DialogTitle>
          </DialogHeader>
          <Select aria-label={t("assign")} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t("unassigned")}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssignOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} onClick={() => run(() => assignOrder(slug, orderId, assignee || null), () => setAssignOpen(false))}>{tc("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
