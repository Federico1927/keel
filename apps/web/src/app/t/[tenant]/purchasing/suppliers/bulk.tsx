"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@hullwise/ui";
import { bulkSupplierAction } from "@/server/actions/purchasing-terms";

/** Default supplier in bulk: variants by product type, vendor or SKU prefix, optionally only those without one. */
export function BulkSupplierCard({ slug, suppliers, productTypes, vendors, withoutSupplier }: { slug: string; suppliers: { id: string; name: string }[]; productTypes: string[]; vendors: string[]; withoutSupplier: number }) {
  const t = useTranslations("supplier_terms");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(bulkSupplierAction.bind(null, slug), null);
  return (
    <Card data-testid="bulk-supplier-card">
      <CardHeader>
        <CardTitle className="text-base">{t("bulk_title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("bulk_hint", { n: withoutSupplier })}</p>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-supplier">{t("columns.supplier")}</Label>
            <Select id="bulk-supplier" name="supplierId" required>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-type">{t("filter.product_type")}</Label>
            <Select id="bulk-type" name="productType" defaultValue="">
              <option value="">{t("filter.any")}</option>
              {productTypes.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-vendor">{t("filter.vendor")}</Label>
            <Select id="bulk-vendor" name="vendor" defaultValue="">
              <option value="">{t("filter.any")}</option>
              {vendors.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-sku">{t("filter.sku_prefix")}</Label>
            <Input id="bulk-sku" name="skuPrefix" maxLength={60} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-cost">{t("columns.cost")}</Label>
            <Input id="bulk-cost" name="unitCost" type="number" step="0.01" min={0} placeholder={t("keep")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-moq">{t("columns.moq")}</Label>
            <Input id="bulk-moq" name="moq" type="number" min={0} placeholder={t("keep")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-lead">{t("columns.lead_time")}</Label>
            <Input id="bulk-lead" name="leadTimeDays" type="number" min={0} placeholder={t("keep")} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Checkbox name="onlyWithoutSupplier" defaultChecked /> {t("filter.only_without")}
          </label>
          {state && !state.ok && <Alert variant="destructive" className="sm:col-span-2 lg:col-span-4"><AlertDescription>{state.error === "invalid_input" ? t("filter.required") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          {state?.ok && <Alert variant="info" className="sm:col-span-2 lg:col-span-4"><AlertDescription>{t("bulk_done", { n: state.data?.updated ?? 0, matched: state.data?.matched ?? 0 })}</AlertDescription></Alert>}
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={pending || suppliers.length === 0}>{t("bulk_apply")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
