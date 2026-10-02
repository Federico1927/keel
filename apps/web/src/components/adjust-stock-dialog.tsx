"use client";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SlidersHorizontal } from "lucide-react";
import { ADJUSTMENT_REASONS, type AdjustmentReason } from "@hullwise/core";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import { adjustStockAction } from "@/server/actions/inventory-control";

export interface AdjustVariant {
  id: string;
  label: string;
  /** Available units per location id. */
  levels: Record<string, number>;
}

/**
 * Stock adjustment with a reason code (issue #30). Damaged and lost take units away, found brings
 * them back, a count correction or "other" goes either way; "other" needs a note. The server
 * validates again and pushes the new level to the platform.
 */
export function AdjustStockDialog({ slug, variants, locations, defaultLocationId, compact = false }: { slug: string; variants: AdjustVariant[]; locations: { id: string; name: string }[]; defaultLocationId?: string | null; compact?: boolean }) {
  const t = useTranslations("inventory_control.adjust");
  const tr = useTranslations("inventory_control.reasons");
  const te = useTranslations("inventory_control.errors");
  const [open, setOpen] = useState(false);
  const [variantId, setVariantId] = useState(variants[0]?.id ?? "");
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations[0]?.id ?? "");
  const [reason, setReason] = useState<AdjustmentReason>("damaged");
  const [direction, setDirection] = useState<"add" | "remove">("remove");
  const [qty, setQty] = useState("1");
  const [state, action, pending] = useActionState(adjustStockAction.bind(null, slug), null);
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state]);
  const sign = reason === "damaged" || reason === "lost" ? -1 : reason === "found" ? 1 : direction === "add" ? 1 : -1;
  const units = Math.max(0, Math.trunc(Number(qty) || 0));
  const current = variants.find((v) => v.id === variantId)?.levels[locationId] ?? 0;
  const next = current + sign * units;
  const errorKey = state && !state.ok ? (state.fieldErrors?.reason ?? state.error) : null;
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="adjust-stock" aria-label={t("button")} className={compact ? "h-7 px-2" : undefined}>
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {!compact && t("button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{variants.length === 1 ? variants[0]!.label : t("description")}</DialogDescription>
          </DialogHeader>
          <form action={action} className="space-y-3" data-testid="adjust-form">
            <input type="hidden" name="delta" value={sign * units} />
            {variants.length === 1 ? (
              <input type="hidden" name="variantId" value={variantId} />
            ) : (
              <div className="space-y-1">
                <Label htmlFor="adj-variant">{t("variant")}</Label>
                <Select id="adj-variant" name="variantId" value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </Select>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="adj-location">{t("location")}</Label>
                <Select id="adj-location" name="locationId" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-reason">{t("reason")}</Label>
                <Select id="adj-reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)} data-testid="adjust-reason">
                  {ADJUSTMENT_REASONS.map((r) => (
                    <option key={r} value={r}>{tr(r)}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(reason === "count_correction" || reason === "other") && (
                <div className="space-y-1">
                  <Label htmlFor="adj-direction">{t("direction")}</Label>
                  <Select id="adj-direction" value={direction} onChange={(e) => setDirection(e.target.value as "add" | "remove")} data-testid="adjust-direction">
                    <option value="remove">{t("remove")}</option>
                    <option value="add">{t("add")}</option>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="adj-qty">{t("quantity")}</Label>
                <Input id="adj-qty" type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} data-testid="adjust-qty" required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-note">{reason === "other" ? t("note_required") : t("note")}</Label>
              <Textarea id="adj-note" name="note" rows={2} maxLength={500} required={reason === "other"} />
            </div>
            <p className="text-sm text-muted-foreground" data-testid="adjust-preview">
              {t("preview", { current, next, delta: `${sign > 0 ? "+" : "−"}${units}` })}
            </p>
            {errorKey && (
              <Alert variant="destructive">
                <AlertDescription>{te(errorKey)}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending || units === 0 || next < 0} data-testid="adjust-submit">{t("submit")}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
