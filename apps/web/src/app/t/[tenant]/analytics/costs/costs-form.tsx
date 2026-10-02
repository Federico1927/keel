"use client";
import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select } from "@hullwise/ui";
import { deletePeriodCostAction, savePeriodCostAction } from "@/server/actions/costs";

/** One cost line: inline "add" form, or a dialog ("edit") when compact. */
export function CostLineForm({ slug, period, kind, label, estimate, actual, compact }: { slug: string; period: string; kind: "fixed" | "shipping" | "other"; label: string; estimate: number; actual: number | null; compact?: boolean }) {
  const t = useTranslations("analytics.costs");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(savePeriodCostAction.bind(null, slug), null);
  const uid = useId();
  const form = (
    <form action={action} className={compact ? "space-y-3" : "grid gap-2 sm:grid-cols-[1fr_8rem_9rem_9rem_auto] sm:items-end"} onSubmit={() => compact && setTimeout(() => setOpen(false), 400)}>
      <input type="hidden" name="period" value={period} />
      {kind === "shipping" ? <input type="hidden" name="kind" value="shipping" /> : (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-label`}>{t("line")}</Label>
          <div className="flex gap-1">
            <Input id={`${uid}-label`} name="label" defaultValue={label} placeholder={t("label_placeholder")} required={!compact} readOnly={compact && !!label} />
            <Select name="kind" defaultValue={kind} aria-label={t("kind")}><option value="fixed">{t("kind_fixed")}</option><option value="other">{t("kind_other")}</option></Select>
          </div>
        </div>
      )}
      {kind === "shipping" && <p className="text-sm text-muted-foreground">{t("shipping_dialog_help")}</p>}
      <div className="space-y-1"><Label htmlFor={`${uid}-est`}>{t("estimate")}</Label><Input id={`${uid}-est`} name="estimate" type="number" step="0.01" min={0} defaultValue={estimate ? estimate.toFixed(2) : ""} /></div>
      <div className="space-y-1"><Label htmlFor={`${uid}-act`}>{t("actual")}</Label><Input id={`${uid}-act`} name="actual" type="number" step="0.01" min={0} defaultValue={actual !== null ? actual.toFixed(2) : ""} placeholder={t("actual_placeholder")} /></div>
      {!compact && <div className="space-y-1"><Label htmlFor={`${uid}-note`}>{t("note")}</Label><Input id={`${uid}-note`} name="note" /></div>}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid={compact ? "cost-save" : "cost-add"}>{compact ? tc("save") : t("add_line")}</Button>
        {state?.ok && <span className="text-xs text-muted-foreground">{tc("saved")}</span>}
        {state && !state.ok && <span className="text-xs text-destructive">{tc(`errors.${state.error}`)}</span>}
      </div>
    </form>
  );
  if (!compact) return form;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="cost-edit">{tc("edit")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{kind === "shipping" ? t("shipping") : label || t("fixed")} · {period}</DialogTitle></DialogHeader>
          {form}
          <DialogFooter />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeleteCostButton({ slug, id }: { slug: string; id: string }) {
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await deletePeriodCostAction(slug, id); router.refresh(); })}>{tc("delete")}</Button>;
}
