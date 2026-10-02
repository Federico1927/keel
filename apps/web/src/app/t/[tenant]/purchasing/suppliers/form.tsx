"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@hullwise/ui";
import { saveSupplier } from "@/server/actions/purchasing";

export interface SupplierFormValues {
  id: string;
  name: string;
  payeeName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  leadTimeDays: number | null;
  contactName: string | null;
  leadTimeSdDays: number | null;
  depositBps: number;
  balanceDays: number;
  moqDefault: number | null;
  orderMultipleDefault: number | null;
}

const TEXT = ["name", "contactName", "payeeName", "email", "phone", "country"] as const;
const TERMS = ["leadTimeDays", "leadTimeSdDays", "depositPct", "balanceDays", "moqDefault", "orderMultipleDefault"] as const;

/** Add a supplier, or edit one (master data and purchasing terms used by the planner). */
export function SupplierForm({ slug, supplier, cancelHref }: { slug: string; supplier?: SupplierFormValues; cancelHref?: string }) {
  const t = useTranslations("suppliers");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveSupplier.bind(null, slug), null);
  const value = (f: (typeof TEXT)[number] | (typeof TERMS)[number]): string => {
    if (!supplier) return f === "balanceDays" ? "30" : "";
    if (f === "depositPct") return String(supplier.depositBps / 100);
    const v = supplier[f];
    return v === null || v === undefined ? "" : String(v);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{supplier ? t("edit_title", { name: supplier.name }) : t("add_title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3" key={supplier?.id ?? "new"} data-testid="supplier-form">
          {supplier && <input type="hidden" name="id" value={supplier.id} />}
          {TEXT.map((f) => (
            <div key={f} className="space-y-1.5">
              <Label htmlFor={`sup-${f}`}>{t(`fields.${f}`)}</Label>
              <Input id={`sup-${f}`} name={f} type={f === "email" ? "email" : "text"} required={f === "name"} defaultValue={value(f)} />
            </div>
          ))}
          <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("terms")}</p>
          <div className="grid grid-cols-2 gap-2">
            {TERMS.map((f) => (
              <div key={f} className="space-y-1.5">
                <Label htmlFor={`sup-${f}`} className="text-xs">{t(`fields.${f}`)}</Label>
                <Input id={`sup-${f}`} name={f} type="number" min={0} step={f === "depositPct" ? "0.1" : "1"} defaultValue={value(f)} />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("terms_hint")}</p>
          {state && <Alert variant={state.ok ? "info" : "destructive"}><AlertDescription>{state.ok ? tc("saved") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={pending}>{supplier ? tc("save") : t("add")}</Button>
            {cancelHref && <Link href={cancelHref} className="inline-flex h-9 items-center rounded-md border px-3 text-sm">{tc("cancel")}</Link>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
