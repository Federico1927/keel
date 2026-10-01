"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { PLAN_KEYS } from "@keel/config";
import { Alert, AlertDescription, Button, Card, CardContent, Input, Label, Select } from "@keel/ui";
import { createTenantAction } from "@/server/actions/admin";

export function NewTenantForm() {
  const t = useTranslations("admin.new_tenant");
  const tp = useTranslations("admin.plans");
  const tc = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState(createTenantAction, null);
  const [name, setName] = useState("");
  const slug = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  useEffect(() => {
    if (state?.ok && state.data && !state.data.temporaryPassword) router.push(`/admin/tenants/${state.data.tenantId}`);
  }, [state, router]);
  if (state?.ok && state.data?.temporaryPassword) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <Alert>
            <AlertDescription>
              <p className="font-medium">{t("created")}</p>
              <p className="mt-1 text-sm">{t("temp_password")} <code className="rounded bg-muted px-1 py-0.5" data-testid="temp-password">{state.data.temporaryPassword}</code></p>
            </AlertDescription>
          </Alert>
          <Button onClick={() => router.push(`/admin/tenants/${state.data!.tenantId}`)}>{t("open_checklist")}</Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <form action={action}>
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="nt-name">{t("fields.name")}</Label><Input id="nt-name" name="name" required value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="nt-slug">{t("fields.slug")}</Label><Input id="nt-slug" name="slug" required defaultValue={slug} key={slug} /></div>
          <div className="space-y-1"><Label htmlFor="nt-country">{t("fields.country")}</Label><Input id="nt-country" name="country" required maxLength={2} placeholder="IT" className="uppercase" /></div>
          <div className="space-y-1"><Label htmlFor="nt-currency">{t("fields.currency")}</Label><Input id="nt-currency" name="currency" required maxLength={3} placeholder="EUR" className="uppercase" /></div>
          <div className="space-y-1"><Label htmlFor="nt-timezone">{t("fields.timezone")}</Label><Input id="nt-timezone" name="timezone" required placeholder="Europe/Rome" /></div>
          <div className="space-y-1"><Label htmlFor="nt-locale">{t("fields.locale")}</Label><Select id="nt-locale" name="defaultLocale" defaultValue="en"><option value="en">English</option><option value="it">Italiano</option><option value="es">Español</option></Select></div>
          <div className="space-y-1"><Label htmlFor="nt-prefix">{t("fields.prefix")}</Label><Input id="nt-prefix" name="orderNumberPrefix" maxLength={10} placeholder="AB-" /></div>
          <div className="space-y-1"><Label htmlFor="nt-tax">{t("fields.tax")}</Label><Input id="nt-tax" name="taxRateBps" type="number" min={0} max={5000} defaultValue={2200} /></div>
          <div className="space-y-1"><Label htmlFor="nt-plan">{t("fields.plan")}</Label><Select id="nt-plan" name="planKey" defaultValue="starter">{PLAN_KEYS.map((p) => <option key={p} value={p}>{tp(p)}</option>)}</Select></div>
          <div className="space-y-1"><Label htmlFor="nt-owner-email">{t("fields.owner_email")}</Label><Input id="nt-owner-email" name="ownerEmail" type="email" required /></div>
          <div className="space-y-1"><Label htmlFor="nt-owner-name">{t("fields.owner_name")}</Label><Input id="nt-owner-name" name="ownerName" required /></div>
          {state && !state.ok && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : tc(`errors.${state.error}`)}{state.fieldErrors ? ` (${Object.keys(state.fieldErrors).join(", ")})` : ""}</AlertDescription>
            </Alert>
          )}
          <div className="sm:col-span-2"><Button type="submit" disabled={pending}>{t("submit")}</Button></div>
        </CardContent>
      </Card>
    </form>
  );
}
