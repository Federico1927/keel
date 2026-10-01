"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch } from "@keel/ui";
import { saveReturnReasonAction, toggleReturnReasonAction } from "@/server/actions/returns";

export function ReasonForm({ slug }: { slug: string }) {
  const t = useTranslations("return_reasons");
  const tc = useTranslations("common");
  const td = useTranslations("return_detail");
  const [state, action, pending] = useActionState(saveReturnReasonAction.bind(null, slug), null);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t("add_title")}</CardTitle></CardHeader>
      <CardContent>
        <form action={action} className="grid gap-3 sm:grid-cols-[8rem_1fr_10rem_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="reason-code">{t("code")}</Label>
            <Input id="reason-code" name="code" required maxLength={40} placeholder="wrong_size" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reason-label">{t("label")}</Label>
            <Input id="reason-label" name="label" required maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reason-fault">{t("default_fault")}</Label>
            <Select id="reason-fault" name="defaultFault" defaultValue="undetermined">
              {(["merchant", "customer", "undetermined"] as const).map((f) => (
                <option key={f} value={f}>{td(`faults.${f}`)}</option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={pending}>{tc("save")}</Button>
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
