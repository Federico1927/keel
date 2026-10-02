"use client";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil } from "lucide-react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select } from "@hullwise/ui";
import { bulkSupplierAction, saveVariantSupplierAction } from "@/server/actions/purchasing-terms";

interface VariantTerms {
  id: string;
  title: string;
  supplierId: string | null;
  supplierSku: string | null;
  unitCost: string;
  moq: number | null;
  orderMultiple: number | null;
  leadTimeDays: number | null;
}

function TermsFields({ prefix, suppliers, v, bulk }: { prefix: string; suppliers: { id: string; name: string }[]; v?: VariantTerms; bulk?: boolean }) {
  const t = useTranslations("supplier_terms");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${prefix}-supplier`}>{t("columns.supplier")}</Label>
        <Select id={`${prefix}-supplier`} name="supplierId" defaultValue={v?.supplierId ?? (bulk ? suppliers[0]?.id : "")} required={bulk}>
          {!bulk && <option value="">{t("none")}</option>}
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </div>
      {!bulk && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${prefix}-sku`}>{t("columns.supplier_sku")}</Label>
          <Input id={`${prefix}-sku`} name="supplierSku" defaultValue={v?.supplierSku ?? ""} maxLength={80} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-cost`}>{t("columns.cost")}</Label>
        <Input id={`${prefix}-cost`} name="unitCost" type="number" step="0.01" min={0} defaultValue={v?.unitCost ?? ""} placeholder={bulk ? t("keep") : undefined} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-moq`}>{t("columns.moq")}</Label>
        <Input id={`${prefix}-moq`} name="moq" type="number" min={0} defaultValue={v?.moq ?? ""} placeholder={bulk ? t("keep") : undefined} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-multiple`}>{t("columns.multiple")}</Label>
        <Input id={`${prefix}-multiple`} name="orderMultiple" type="number" min={0} defaultValue={v?.orderMultiple ?? ""} placeholder={bulk ? t("keep") : undefined} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-lead`}>{t("columns.lead_time")}</Label>
        <Input id={`${prefix}-lead`} name="leadTimeDays" type="number" min={0} defaultValue={v?.leadTimeDays ?? ""} placeholder={bulk ? t("keep") : undefined} />
      </div>
    </div>
  );
}

/** Edit the default supplier and terms of one variant. */
export function VariantSupplierButton({ slug, suppliers, variant }: { slug: string; suppliers: { id: string; name: string }[]; variant: VariantTerms }) {
  const t = useTranslations("supplier_terms");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(saveVariantSupplierAction.bind(null, slug, variant.id), null);
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state]);
  return (
    <>
      <button type="button" aria-label={t("edit_variant", { variant: variant.title })} onClick={() => setOpen(true)} className="rounded p-1 text-muted-foreground hover:text-foreground" data-testid="variant-supplier-edit">
        <Pencil className="h-4 w-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("edit_variant", { variant: variant.title })}</DialogTitle>
          </DialogHeader>
          <form action={action} className="space-y-4" data-testid="variant-supplier-form">
            <TermsFields prefix={`vs-${variant.id}`} suppliers={suppliers} v={variant} />
            {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
              <Button type="submit" disabled={pending}>{tc("save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Same supplier and terms for every variant of the product (empty fields keep the current value). */
export function BulkSupplierForm({ slug, productId, suppliers }: { slug: string; productId: string; suppliers: { id: string; name: string }[] }) {
  const t = useTranslations("supplier_terms");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(bulkSupplierAction.bind(null, slug), null);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="bulk-supplier-open">{t("set_all")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("set_all")}</DialogTitle>
          </DialogHeader>
          <form action={action} className="space-y-4" data-testid="bulk-supplier-form">
            <input type="hidden" name="productId" value={productId} />
            <p className="text-sm text-muted-foreground">{t("set_all_hint")}</p>
            <TermsFields prefix="bulk" suppliers={suppliers} bulk />
            {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
            {state?.ok && <Alert variant="info"><AlertDescription>{t("updated", { n: state.data?.updated ?? 0 })}</AlertDescription></Alert>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
              <Button type="submit" disabled={pending}>{tc("save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
