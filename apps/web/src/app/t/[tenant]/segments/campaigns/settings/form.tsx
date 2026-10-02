"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@hullwise/ui";
import { saveCampaignSettingsAction } from "@/server/actions/retention";

interface Values {
  campaignFrequencyCap: number;
  campaignFrequencyDays: number;
  campaignSendStartHour: number;
  campaignSendEndHour: number;
  throttleEmail: number;
  throttleSms: number;
  throttleWhatsapp: number;
  campaignMeasurementLock: boolean;
}

export function CampaignSettingsForm({ slug, values }: { slug: string; values: Values }) {
  const t = useTranslations("retention.settings");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCampaignSettingsAction.bind(null, slug), null);
  const field = (name: keyof Values, min: number, max: number) => (
    <div className="space-y-1">
      <Label htmlFor={name}>{t(`fields.${name}`)}</Label>
      <Input id={name} name={name} type="number" min={min} max={max} step={1} required defaultValue={String(values[name])} />
    </div>
  );
  return (
    <form action={action} className="space-y-4" data-testid="campaign-settings">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cap_title")}</CardTitle>
          <CardDescription>{t("cap_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field("campaignFrequencyCap", 1, 100)}
          {field("campaignFrequencyDays", 1, 365)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("window_title")}</CardTitle>
          <CardDescription>{t("window_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field("campaignSendStartHour", 0, 23)}
          {field("campaignSendEndHour", 1, 24)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("throttle_title")}</CardTitle>
          <CardDescription>{t("throttle_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {field("throttleEmail", 1, 100000)}
          {field("throttleSms", 1, 100000)}
          {field("throttleWhatsapp", 1, 100000)}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="campaignMeasurementLock" defaultChecked={values.campaignMeasurementLock} className="mt-0.5" />
            <span>{t("fields.campaignMeasurementLock")}<span className="block text-xs text-muted-foreground">{t("lock_hint")}</span></span>
          </label>
        </CardContent>
      </Card>
      {state && !state.ok && (
        <Alert variant="destructive">
          <AlertDescription>{tc.has(`errors.${state.error}`) ? tc(`errors.${state.error}`) : state.error}</AlertDescription>
        </Alert>
      )}
      {state?.ok && <p className="text-sm text-success" data-testid="settings-saved">{tc("saved")}</p>}
      <Button type="submit" disabled={pending}>{tc("save")}</Button>
    </form>
  );
}
