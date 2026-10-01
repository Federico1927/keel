"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label, Textarea } from "@keel/ui";
import { supplierAckAction } from "@/server/actions/planning";

export function SupplierAckForm({ token, defaultDate, previousNote }: { token: string; defaultDate: string; previousNote: string | null }) {
  const t = useTranslations("supplier_portal");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(supplierAckAction.bind(null, token), null);
  const [decision, setDecision] = useState<"confirm" | "problem">("confirm");
  if (state?.ok) return <Alert variant="info"><AlertDescription data-testid="supplier-ack-done">{t("thanks")}</AlertDescription></Alert>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="decision" value={decision} />
      <div className="flex gap-2" role="radiogroup">
        {(["confirm", "problem"] as const).map((d) => (
          <Button key={d} type="button" role="radio" aria-checked={decision === d} variant={decision === d ? "default" : "outline"} onClick={() => setDecision(d)}>{t(`decision.${d}`)}</Button>
        ))}
      </div>
      {decision === "confirm" && (
        <div className="space-y-1.5">
          <Label htmlFor="ack-date">{t("delivery_date")}</Label>
          <Input id="ack-date" name="expectedAt" type="date" defaultValue={defaultDate} className="w-48" />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="ack-note">{decision === "problem" ? t("problem_note") : t("note")}</Label>
        <Textarea id="ack-note" name="note" rows={3} required={decision === "problem"} defaultValue={previousNote ?? ""} />
      </div>
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{state.error === "link_expired" ? t("inactive_body") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      <Button type="submit" disabled={pending} data-testid="supplier-ack-submit">{t(`submit.${decision}`)}</Button>
    </form>
  );
}
