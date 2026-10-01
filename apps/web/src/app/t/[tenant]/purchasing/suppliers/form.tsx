"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@keel/ui";
import { saveSupplier } from "@/server/actions/purchasing";

export function SupplierForm({ slug }: { slug: string }) {
  const t = useTranslations("suppliers");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveSupplier.bind(null, slug), null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("add_title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          {(["name", "payeeName", "email", "phone", "country", "leadTimeDays"] as const).map((f) => (
            <div key={f} className="space-y-1.5">
              <Label htmlFor={`sup-${f}`}>{t(`fields.${f}`)}</Label>
              <Input id={`sup-${f}`} name={f} type={f === "leadTimeDays" ? "number" : f === "email" ? "email" : "text"} required={f === "name"} />
            </div>
          ))}
          {state && <Alert variant={state.ok ? "info" : "destructive"}><AlertDescription>{state.ok ? tc("saved") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          <Button type="submit" className="w-full" disabled={pending}>{t("add")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
