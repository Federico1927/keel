"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@keel/ui";
import { addPoChargeAction, deletePoChargeAction, sendPoToSupplierAction } from "@/server/actions/planning";

export interface ChargeView {
  id: string;
  kind: string;
  basis: string;
  amount: string;
  note: string | null;
}

/** Duties, freight and fees of the PO; each change reallocates landed cost to the lines. */
export function LandedCostCard({ slug, poId, charges, total, canWrite }: { slug: string; poId: string; charges: ChargeView[]; total: string; canWrite: boolean }) {
  const t = useTranslations("po_detail.landed");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(addPoChargeAction.bind(null, slug, poId), null);
  const [deleting, start] = useTransition();
  return (
    <Card data-testid="landed-cost-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {charges.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-1">
            {charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>
                  {t(`kinds.${c.kind}`)} <span className="text-xs text-muted-foreground">· {t(`bases.${c.basis}`)}{c.note ? ` · ${c.note}` : ""}</span>
                </span>
                <span className="flex items-center gap-1 tabular">
                  {c.amount}
                  {canWrite && (
                    <button type="button" aria-label={tc("delete")} disabled={deleting} onClick={() => start(() => void deletePoChargeAction(slug, poId, c.id))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
            <li className="flex justify-between border-t pt-1 font-medium"><span>{t("total")}</span><span className="tabular">{total}</span></li>
          </ul>
        )}
        {canWrite && (
          <form action={action} className="grid grid-cols-2 gap-2 border-t pt-3">
            <div className="space-y-1">
              <Label htmlFor="charge-kind" className="text-xs">{t("kind")}</Label>
              <Select id="charge-kind" name="kind" defaultValue="freight">
                {["freight", "duty", "fee", "other"].map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="charge-basis" className="text-xs">{t("basis")}</Label>
              <Select id="charge-basis" name="basis" defaultValue="value">
                {["value", "quantity", "weight"].map((k) => <option key={k} value={k}>{t(`bases.${k}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="charge-amount" className="text-xs">{t("amount")}</Label>
              <Input id="charge-amount" name="amount" type="number" step="0.01" min="0.01" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="charge-note" className="text-xs">{t("note")}</Label>
              <Input id="charge-note" name="note" />
            </div>
            {state && !state.ok && <Alert variant="destructive" className="col-span-2"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
            <Button type="submit" size="sm" variant="secondary" className="col-span-2" disabled={pending}>{t("add")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Send to the supplier (PDF + confirmation link) and see what the supplier answered. */
export function SupplierCard({ slug, poId, status, defaultEmail, sentTo, sentAt, ackAt, ackNote, pdfHref, canWrite }: { slug: string; poId: string; status: string; defaultEmail: string | null; sentTo: string | null; sentAt: string | null; ackAt: string | null; ackNote: string | null; pdfHref: string; canWrite: boolean }) {
  const t = useTranslations("po_detail.supplier");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(sendPoToSupplierAction.bind(null, slug, poId), null);
  const sendable = ["draft", "sent", "confirmed"].includes(status);
  return (
    <Card data-testid="supplier-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <a href={pdfHref} className="inline-flex text-primary hover:underline" data-testid="po-pdf">{t("download_pdf")}</a>
        {sentAt && <p className="text-muted-foreground">{t("sent", { at: sentAt, to: sentTo ?? "—" })}</p>}
        {ackAt ? (
          <Alert variant="info"><AlertDescription>{t("acknowledged", { at: ackAt })}{ackNote ? ` — ${ackNote}` : ""}</AlertDescription></Alert>
        ) : sentAt ? (
          <p className="text-muted-foreground">{t("waiting")}</p>
        ) : null}
        {canWrite && sendable && (
          <form action={action} className="space-y-2 border-t pt-3">
            <Label htmlFor="po-send-email" className="text-xs">{t("email")}</Label>
            <Input id="po-send-email" name="email" type="email" defaultValue={defaultEmail ?? ""} />
            <Button type="submit" size="sm" className="w-full" disabled={pending} data-testid="po-send">{sentAt ? t("resend") : t("send")}</Button>
            {state?.ok && state.data && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t("link_hint")}</p>
                <Input readOnly value={state.data.url} data-testid="supplier-link" onFocus={(e) => e.currentTarget.select()} />
              </div>
            )}
            {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
