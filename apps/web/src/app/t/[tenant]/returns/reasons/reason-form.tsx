"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch } from "@hullwise/ui";
import { saveReturnReasonAction, toggleReturnReasonAction } from "@/server/actions/returns";

export interface ReasonValues {
  id: string;
  code: string;
  label: string;
  defaultFault: string;
  platformReason: string | null;
  labels: Record<string, string>;
}

export function ReasonForm({ slug, reason, locales, platformReasons }: { slug: string; reason?: ReasonValues; locales: string[]; platformReasons: readonly string[] }) {
  const t = useTranslations("return_reasons");
  const tc = useTranslations("common");
  const td = useTranslations("return_detail");
  const [state, action, pending] = useActionState(saveReturnReasonAction.bind(null, slug), null);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{reason ? t("edit_title", { code: reason.code }) : t("add_title")}</CardTitle></CardHeader>
      <CardContent>
        <form action={action} key={reason?.id ?? "new"} className="grid gap-3 sm:grid-cols-[8rem_1fr_10rem_auto] sm:items-end" data-testid="reason-form">
          {reason && <input type="hidden" name="reasonId" value={reason.id} />}
          <div className="space-y-1">
            <Label htmlFor="reason-code">{t("code")}</Label>
            <Input id="reason-code" name="code" required maxLength={40} placeholder="wrong_size" defaultValue={reason?.code} readOnly={Boolean(reason)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reason-label">{t("label")}</Label>
            <Input id="reason-label" name="label" required maxLength={120} defaultValue={reason?.label} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reason-fault">{t("default_fault")}</Label>
            <Select id="reason-fault" name="defaultFault" defaultValue={reason?.defaultFault ?? "undetermined"}>
              {(["merchant", "customer", "undetermined"] as const).map((f) => (
                <option key={f} value={f}>{td(`faults.${f}`)}</option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={pending}>{tc("save")}</Button>
          <div className="grid gap-3 sm:col-span-4 sm:grid-cols-4">
            {locales.map((l) => (
              <div key={l} className="space-y-1">
                <Label htmlFor={`reason-label-${l}`} className="text-xs">{t("portal_label", { lang: l.toUpperCase() })}</Label>
                <Input id={`reason-label-${l}`} name={`label_${l}`} maxLength={120} defaultValue={reason?.labels[l] ?? ""} />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="reason-platform" className="text-xs">{t("platform_reason")}</Label>
              <Select id="reason-platform" name="platformReason" defaultValue={reason?.platformReason ?? ""}>
                <option value="">{t("platform_reason_other")}</option>
                {platformReasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </div>
          </div>
          {state?.ok && <Alert variant="info" className="sm:col-span-4"><AlertDescription>{tc("saved")}</AlertDescription></Alert>}
          {state && !state.ok && (
            <Alert variant="destructive" className="sm:col-span-4">
              <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function ReasonToggle({ slug, reasonId, isActive }: { slug: string; reasonId: string; isActive: boolean }) {
  const [pending, start] = useTransition();
  return <Switch checked={isActive} disabled={pending} onCheckedChange={(v) => start(async () => void (await toggleReturnReasonAction(slug, reasonId, v)))} aria-label="active" />;
}
