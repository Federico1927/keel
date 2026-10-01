"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RETENTION_CHANNELS } from "@keel/core";
import { Alert, AlertDescription, Button, Input, Label, Select, Textarea } from "@keel/ui";
import { saveRetentionCampaignAction } from "@/server/actions/retention";

export interface CampaignFormValues {
  id?: string;
  name: string;
  segmentId: string;
  channel: string;
  message: string;
  discountCode: string | null;
  costPerMessageMinor: number;
  attributionDays: number;
}

export function CampaignForm({ slug, values, segments, currency }: { slug: string; values: CampaignFormValues; segments: { id: string; name: string; holdoutPercentage: number; lastCount: number | null }[]; currency: string }) {
  const t = useTranslations("retention");
  const tc = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState(saveRetentionCampaignAction.bind(null, slug, values.id ?? null), null);
  const [segmentId, setSegmentId] = useState(values.segmentId || segments[0]?.id || "");
  const [channel, setChannel] = useState(values.channel);
  const segment = segments.find((s) => s.id === segmentId);
  useEffect(() => {
    if (state?.ok && state.data) {
      if (values.id) router.refresh();
      else router.push(`/t/${slug}/segments/campaigns/${state.data.id}`);
    }
  }, [state, router, slug, values.id]);
  const error = state && !state.ok ? (tc.has(`errors.${state.error}`) ? tc(`errors.${state.error}`) : t(`errors.${state.error}`)) : null;
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="rc-name">{t("fields.name")}</Label>
        <Input id="rc-name" name="name" required maxLength={120} defaultValue={values.name} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rc-segment">{t("fields.segment")}</Label>
        <Select id="rc-segment" name="segmentId" value={segmentId} onChange={(e) => setSegmentId(e.target.value)} required>
          {segments.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        {segment && (
          <p className={segment.holdoutPercentage > 0 ? "text-xs text-muted-foreground" : "text-xs text-warning"} data-testid="holdout-hint">
            {segment.holdoutPercentage > 0 ? t("holdout_hint", { pct: segment.holdoutPercentage }) : t("no_holdout_warning")}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="rc-channel">{t("fields.channel")}</Label>
        <Select id="rc-channel" name="channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {RETENTION_CHANNELS.map((c) => (
            <option key={c} value={c}>{t(`channels.${c}`)}</option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t(`channel_hint.${channel}`)}</p>
      </div>
      {channel !== "manual" && (
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="rc-message">{t("fields.message")}</Label>
          <Textarea id="rc-message" name="message" rows={3} maxLength={2000} defaultValue={values.message} />
          <p className="text-xs text-muted-foreground">{t("message_hint")}</p>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="rc-code">{t("fields.discount_code")}</Label>
        <Input id="rc-code" name="discountCode" maxLength={40} defaultValue={values.discountCode ?? ""} className="font-mono uppercase" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rc-cost">{t("fields.cost", { currency })}</Label>
        <Input id="rc-cost" name="costPerMessage" type="number" min={0} step="0.001" defaultValue={values.costPerMessageMinor / 100} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rc-days">{t("fields.attribution_days")}</Label>
        <Input id="rc-days" name="attributionDays" type="number" min={1} max={90} required defaultValue={values.attributionDays} />
      </div>
      {error && (
        <Alert variant="destructive" className="sm:col-span-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending || !segments.length}>{values.id ? t("save_draft") : t("create")}</Button>
      </div>
    </form>
  );
}
