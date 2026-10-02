"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Send, Trash2 } from "lucide-react";
import type { SendPreview } from "@hullwise/services";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@hullwise/ui";
import { deleteRetentionCampaignAction, previewRetentionSendAction, sendRetentionCampaignAction } from "@/server/actions/retention";

/** Draft actions: preview the groups and the detectable uplift, confirm, send; or delete the draft. */
export function SendPanel({ slug, campaignId, locale }: { slug: string; campaignId: string; locale: string }) {
  const t = useTranslations("retention");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const message = (code: string) => (tc.has(`errors.${code}`) ? tc(`errors.${code}`) : t(`errors.${code}`));
  const pct = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(v));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && <span className="text-sm text-destructive">{message(error)}</span>}
      <Button disabled={pending} onClick={() => start(async () => { const r = await previewRetentionSendAction(slug, campaignId); if (!r.ok) setError(r.error); else { setError(null); setPreview(r.data ?? null); } })}>
        <Send /> {t("send")}
      </Button>
      <Button variant="ghost" disabled={pending} aria-label={tc("delete")} onClick={() => start(async () => { const r = await deleteRetentionCampaignAction(slug, campaignId); if (!r.ok) setError(r.error); else router.push(`/t/${slug}/segments/campaigns`); })}>
        <Trash2 />
      </Button>
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirm_title")}</DialogTitle>
            <DialogDescription>{preview && t("confirm_description", { treated: preview.treated, holdout: preview.holdout })}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-2 text-sm" data-testid="send-preview">
              {preview.holdout === 0 ? (
                <Alert><AlertDescription>{t("no_holdout_warning")}</AlertDescription></Alert>
              ) : (
                <p>{t("mde", { baseline: pct(preview.baselineRate), mde: pct(preview.minimumDetectableUplift) })}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreview(null)}>{tc("cancel")}</Button>
            <Button disabled={pending || !preview || preview.treated === 0} onClick={() => start(async () => { const r = await sendRetentionCampaignAction(slug, campaignId); setPreview(null); if (!r.ok) setError(r.error); else router.refresh(); })}>{t("confirm_send")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
