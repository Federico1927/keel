"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, Check, FlaskConical, Pause, Play, Send, Trash2, Undo2, X } from "lucide-react";
import { CAMPAIGN_EXCLUSION_REASONS } from "@keel/core";
import type { SendPreview } from "@keel/services";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from "@keel/ui";
import type { ActionResult } from "@/server/action-result";
import { activateSequenceAction, approveRetentionCampaignAction, deleteRetentionCampaignAction, pauseSequenceAction, previewRetentionSendAction, recordManualCampaignAction, rejectRetentionCampaignAction, reopenRetentionCampaignAction, scheduleRetentionCampaignAction, sendCampaignTestAction, submitRetentionCampaignAction, unscheduleRetentionCampaignAction } from "@/server/actions/retention";

export interface WorkflowProps {
  slug: string;
  campaignId: string;
  locale: string;
  status: string;
  kind: string;
  channel: string;
  canWrite: boolean;
  /** Role may approve and the user is not the author (or is the owner). */
  canApprove: boolean;
  /** Internal users for the test send (email channel). */
  members: { id: string; label: string }[];
  /** "HH–HH" in the store's time zone, for the schedule dialog. */
  windowLabel: string;
}

type Dialogs = "preview" | "test" | "reject" | "schedule" | null;

/** Every workflow action of a campaign, by status and permission: preview and submit, test send, approve or send back, schedule, activate or pause. */
export function SendPanel(p: WorkflowProps) {
  const t = useTranslations("retention");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [testUsers, setTestUsers] = useState<string[]>(p.members[0] ? [p.members[0].id] : []);
  const [testPhone, setTestPhone] = useState("");
  const [testDone, setTestDone] = useState<number | null>(null);
  const message = (code: string) => (tc.has(`errors.${code}`) ? tc(`errors.${code}`) : t.has(`errors.${code}`) ? t(`errors.${code}`) : code);
  const pct = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(p.locale, { style: "percent", maximumFractionDigits: 1 }).format(v));
  const num = (v: number) => new Intl.NumberFormat(p.locale).format(v);
  const act = (fn: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      setError(null);
      setDialog(null);
      after?.();
      router.refresh();
    });
  const openPreview = () =>
    start(async () => {
      const r = await previewRetentionSendAction(p.slug, p.campaignId);
      if (!r.ok) return setError(r.error);
      setError(null);
      setPreview(r.data ?? null);
      setDialog("preview");
    });
  const manual = p.channel === "manual";
  const draft = p.status === "draft";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="campaign-actions">
      {error && <span className="text-sm text-destructive" data-testid="campaign-error">{message(error)}</span>}
      {p.canWrite && !manual && ["draft", "pending_approval", "approved", "scheduled", "paused"].includes(p.status) && (
        <Button variant="outline" disabled={pending} onClick={() => { setTestDone(null); setDialog("test"); }}><FlaskConical /> {t("workflow.test")}</Button>
      )}
      {p.canWrite && draft && <Button disabled={pending} onClick={openPreview}><Send /> {manual ? t("workflow.record") : t("workflow.submit")}</Button>}
      {p.canApprove && p.status === "pending_approval" && (
        <>
          <Button disabled={pending} onClick={() => act(() => approveRetentionCampaignAction(p.slug, p.campaignId, ""))}><Check /> {t("workflow.approve")}</Button>
          <Button variant="outline" disabled={pending} onClick={() => setDialog("reject")}><X /> {t("workflow.reject")}</Button>
        </>
      )}
      {p.canWrite && p.status === "approved" && p.kind !== "sequence" && <Button disabled={pending} onClick={() => setDialog("schedule")}><CalendarClock /> {t("workflow.schedule")}</Button>}
      {p.canWrite && p.kind === "sequence" && (p.status === "approved" || p.status === "paused") && <Button disabled={pending} onClick={() => act(() => activateSequenceAction(p.slug, p.campaignId))}><Play /> {t("workflow.activate")}</Button>}
      {p.canWrite && p.status === "active" && <Button variant="outline" disabled={pending} onClick={() => act(() => pauseSequenceAction(p.slug, p.campaignId))}><Pause /> {t("workflow.pause")}</Button>}
      {p.canWrite && p.status === "scheduled" && <Button variant="outline" disabled={pending} onClick={() => act(() => unscheduleRetentionCampaignAction(p.slug, p.campaignId))}>{t("workflow.unschedule")}</Button>}
      {p.canWrite && ["pending_approval", "approved", "scheduled", "paused"].includes(p.status) && (
        <Button variant="ghost" disabled={pending} onClick={() => act(() => reopenRetentionCampaignAction(p.slug, p.campaignId))}><Undo2 /> {t("workflow.reopen")}</Button>
      )}
      {p.canWrite && draft && (
        <Button variant="ghost" disabled={pending} aria-label={tc("delete")} onClick={() => start(async () => { const r = await deleteRetentionCampaignAction(p.slug, p.campaignId); if (!r.ok) setError(r.error); else router.push(`/t/${p.slug}/segments/campaigns`); })}>
          <Trash2 />
        </Button>
      )}

      <Dialog open={dialog === "preview"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{manual ? t("confirm_record_title") : t("confirm_title")}</DialogTitle>
            <DialogDescription>{preview && t("confirm_description", { treated: num(preview.treated), holdout: num(preview.holdout) })}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm" data-testid="send-preview">
              <div>
                <p className="mb-1 font-medium">{t("exclusions.title", { members: num(preview.members) })}</p>
                <ul className="divide-y rounded-md border" data-testid="exclusion-counts">
                  {CAMPAIGN_EXCLUSION_REASONS.map((r) => (
                    <li key={r} className="flex justify-between gap-2 px-3 py-1.5" data-testid={`exclusion-${r}`}>
                      <span className="text-muted-foreground">{t(`exclusions.${r}`)}</span>
                      <span className="tabular">{num(preview.exclusions[r])}</span>
                    </li>
                  ))}
                  {preview.noAddress > 0 && (
                    <li className="flex justify-between gap-2 px-3 py-1.5"><span className="text-muted-foreground">{t("exclusions.no_address")}</span><span className="tabular">{num(preview.noAddress)}</span></li>
                  )}
                </ul>
              </div>
              {preview.holdout === 0 ? <Alert><AlertDescription>{t("no_holdout_warning")}</AlertDescription></Alert> : <p>{t("mde", { baseline: pct(preview.baselineRate), mde: pct(preview.minimumDetectableUplift) })}</p>}
              {!manual && <p className="text-xs text-muted-foreground">{t("workflow.submit_hint")}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{tc("cancel")}</Button>
            <Button disabled={pending || !preview || preview.treated + preview.holdout === 0} onClick={() => act(() => (manual ? recordManualCampaignAction(p.slug, p.campaignId) : submitRetentionCampaignAction(p.slug, p.campaignId)))}>
              {manual ? t("workflow.record_confirm") : t("workflow.submit_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "test"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workflow.test_title")}</DialogTitle>
            <DialogDescription>{t("workflow.test_description")}</DialogDescription>
          </DialogHeader>
          {p.channel === "email" ? (
            <div className="space-y-1 text-sm">
              {p.members.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={testUsers.includes(m.id)} onChange={(e) => setTestUsers(e.target.checked ? [...testUsers, m.id] : testUsers.filter((x) => x !== m.id))} />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="test-phone">{t("workflow.test_phone")}</Label>
              <Input id="test-phone" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+39 333 000 0000" />
            </div>
          )}
          {testDone !== null && <p className="text-sm text-success" data-testid="test-sent">{t("workflow.test_sent", { n: testDone })}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{t("workflow.close")}</Button>
            <Button disabled={pending || (p.channel === "email" ? testUsers.length === 0 : !testPhone.trim())} onClick={() => start(async () => { const r = await sendCampaignTestAction(p.slug, p.campaignId, { userIds: p.channel === "email" ? testUsers : [], phones: p.channel === "email" ? [] : [testPhone] }); if (!r.ok) return setError(r.error); setError(null); setTestDone(r.data?.sent ?? 0); router.refresh(); })}>
              {t("workflow.test_send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workflow.reject_title")}</DialogTitle>
            <DialogDescription>{t("workflow.reject_description")}</DialogDescription>
          </DialogHeader>
          <Textarea aria-label={t("workflow.note")} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{tc("cancel")}</Button>
            <Button disabled={pending || !note.trim()} onClick={() => act(() => rejectRetentionCampaignAction(p.slug, p.campaignId, note), () => setNote(""))}>{t("workflow.reject_confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "schedule"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workflow.schedule_title")}</DialogTitle>
            <DialogDescription>{t("workflow.schedule_description", { window: p.windowLabel })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="schedule-at">{t("workflow.schedule_at")}</Label>
            <Input id="schedule-at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("workflow.schedule_hint")}</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{tc("cancel")}</Button>
            <Button disabled={pending} onClick={() => act(() => scheduleRetentionCampaignAction(p.slug, p.campaignId, when))}>{when ? t("workflow.schedule_confirm") : t("workflow.schedule_now")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Refreshes the page every few seconds while messages are going out, so the progress moves. */
export function LiveRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}
