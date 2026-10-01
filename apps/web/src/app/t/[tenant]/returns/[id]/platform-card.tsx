"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle } from "@keel/ui";
import { retryReturnSyncAction, revealBankDetailsAction, setReturnReviewAction } from "@/server/actions/returns";

/** Where the return stands on the commerce platform, with a retry when the last write failed. */
export function PlatformSyncCard({ slug, returnId, syncStatus, platformStatus, externalId, refundId, error, syncedAt, canAct }: { slug: string; returnId: string; syncStatus: string; platformStatus: string | null; externalId: string | null; refundId: string | null; error: string | null; syncedAt: string | null; canAct: boolean }) {
  const t = useTranslations("return_detail.platform");
  const [pending, start] = useTransition();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Card data-testid="return-platform-card">
      <CardHeader><CardTitle className="text-base">{t("title")}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p data-testid="return-sync-status"><span className="text-muted-foreground">{t("status")}:</span> {t(`sync.${syncStatus}`)}</p>
        {platformStatus && <p><span className="text-muted-foreground">{t("on_platform")}:</span> {t(`platform_status.${platformStatus}`)}{externalId ? ` · #${externalId}` : ""}</p>}
        {refundId && <p><span className="text-muted-foreground">{t("refund")}:</span> #{refundId}</p>}
        {syncedAt && <p className="text-xs text-muted-foreground">{t("synced_at", { at: syncedAt })}</p>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {canAct && (syncStatus === "error" || syncStatus === "pending") && (
          <Button size="sm" variant="outline" disabled={pending} data-testid="return-sync-retry" onClick={() => start(async () => {
            const r = await retryReturnSyncAction(slug, returnId);
            setMessage(r.ok ? t(`sync.${r.data!.sync}`) : r.error);
            router.refresh();
          })}>{t("retry")}</Button>
        )}
      </CardContent>
    </Card>
  );
}

/** IBAN and holder for refunds by transfer; hidden until asked, and every reveal is audited. */
export function BankDetails({ slug, returnId }: { slug: string; returnId: string }) {
  const t = useTranslations("return_detail.portal");
  const [pending, start] = useTransition();
  const [details, setDetails] = useState<{ holder: string; iban: string } | null>(null);
  if (details) return <p data-testid="bank-details"><span className="text-muted-foreground">{t("bank")}:</span> {details.holder} · <code>{details.iban}</code></p>;
  return (
    <button type="button" className="text-primary underline" disabled={pending} data-testid="reveal-bank" onClick={() => start(async () => {
      const r = await revealBankDetailsAction(slug, returnId);
      if (r.ok) setDetails(r.data!);
    })}>{t("reveal_bank")}</button>
  );
}

/** Flag a return for review (or clear the flag set by a person or an automation). */
export function ReviewToggle({ slug, returnId, needsReview }: { slug: string; returnId: string; needsReview: boolean }) {
  const t = useTranslations("return_detail");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button size="sm" variant="outline" disabled={pending} data-testid="return-review-toggle" onClick={() => start(async () => { await setReturnReviewAction(slug, returnId, !needsReview); router.refresh(); })}>
      {needsReview ? t("mark_reviewed") : t("flag_review")}
    </Button>
  );
}
