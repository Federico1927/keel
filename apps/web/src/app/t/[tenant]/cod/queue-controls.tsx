"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from "@hullwise/ui";
import { claimQueueItemAction, distributeAction, orderLinesAction, recordAttemptAction, releaseQueueItemAction, rescoreAction } from "@/server/actions/cod";
import type { ActionResult } from "@/server/action-result";
import { CopyButton } from "./queue-extras";

export function ScoreBadge({ score, tier }: { score: number | null; tier: string | null }) {
  const t = useTranslations("cod");
  if (score === null) return <Badge variant="muted">{t("score.none")}</Badge>;
  const band = score >= 75 ? "likely" : score >= 40 ? "uncertain" : "unlikely";
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={band === "likely" ? "success" : band === "uncertain" ? "warning" : "destructive"} data-testid="score-badge">{score} · {t(`score.${band}`)}</Badge>
      {(tier === "high_risk" || tier === "blacklisted") && <Badge variant="destructive">{t(`risk.${tier}`)}</Badge>}
    </span>
  );
}

const OUTCOMES = ["confirmed", "no_answer", "call_back", "confirm_scheduled", "modified", "cancelled"] as const;

export function OutcomeDialog({ slug, orderId, orderName, compact }: { slug: string; orderId: string; orderName: string; compact?: boolean }) {
  const t = useTranslations("cod");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("confirmed");
  const [note, setNote] = useState("");
  const [callBackAt, setCallBackAt] = useState("");
  const [confirmOn, setConfirmOn] = useState("");
  const [lines, setLines] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  // the warehouse list (SKU × qty) is fetched once, when the dialog opens on "confirmed" (C.6)
  useEffect(() => {
    if (!open || outcome !== "confirmed" || lines !== null) return;
    void orderLinesAction(slug, orderId).then((r) => setLines(r.ok && r.data ? r.data.text : ""));
  }, [open, outcome, lines, slug, orderId]);
  return (
    <>
      <Button size={compact ? "sm" : "default"} onClick={() => setOpen(true)} data-testid="register-outcome">{t("register_outcome")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("outcome_title", { order: orderName })}</DialogTitle>
            <DialogDescription>{t("outcome_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {OUTCOMES.map((o) => (
                <button key={o} type="button" onClick={() => setOutcome(o)} className={`rounded-md border px-3 py-2 text-left text-sm ${outcome === o ? "border-primary bg-primary/10" : ""}`} data-testid={`outcome-${o}`}>
                  <div className="font-medium">{t(`outcomes.${o}`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`outcomes_hint.${o}`)}</div>
                </button>
              ))}
            </div>
            {outcome === "confirmed" && lines && (
              <div className="space-y-1 rounded-md border bg-muted/40 p-2" data-testid="warehouse-lines">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("warehouse_lines")}</span>
                  <CopyButton text={lines} label={t("copy")} testId="copy-lines" />
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs">{lines}</pre>
              </div>
            )}
            {outcome === "confirm_scheduled" && (
              <div className="space-y-1">
                <Label htmlFor="confirm-on">{t("confirm_on")}</Label>
                <Input id="confirm-on" type="date" value={confirmOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setConfirmOn(e.target.value)} data-testid="confirm-on" />
                <p className="text-xs text-muted-foreground">{t("confirm_on_hint")}</p>
              </div>
            )}
            {outcome === "call_back" && (
              <div className="space-y-1">
                <Label htmlFor="cb-at">{t("call_back_at")}</Label>
                <Input id="cb-at" type="datetime-local" value={callBackAt} onChange={(e) => setCallBackAt(e.target.value)} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="attempt-note">{t("note_optional")}</Label>
              <Textarea id="attempt-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {result && !result.ok && (
              <Alert variant="destructive">
                <AlertDescription>{t.has(`errors.${result.error}`) ? t(`errors.${result.error}`) : tc(`errors.${result.error}`)}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              disabled={pending || (outcome === "call_back" && !callBackAt) || (outcome === "confirm_scheduled" && !confirmOn)}
              onClick={() =>
                start(async () => {
                  const r = await recordAttemptAction(slug, { orderId, outcome, note: note || null, callBackAt: outcome === "call_back" ? new Date(callBackAt).toISOString() : null, confirmOn: outcome === "confirm_scheduled" ? confirmOn : null });
                  setResult(r);
                  if (r.ok) {
                    setOpen(false);
                    setNote("");
                    router.refresh();
                  }
                })
              }
            >
              {t("save_outcome")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ClaimButton({ slug, orderId, assignedToMe, assigned, canRelease }: { slug: string; orderId: string; assignedToMe: boolean; assigned: boolean; canRelease: boolean }) {
  const t = useTranslations("cod");
  const router = useRouter();
  const [pending, start] = useTransition();
  if (assignedToMe && canRelease) return <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await releaseQueueItemAction(slug, orderId); router.refresh(); })}>{t("release")}</Button>;
  if (assigned) return null;
  return <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await claimQueueItemAction(slug, orderId); router.refresh(); })} data-testid="claim">{t("claim")}</Button>;
}

export function QueueToolbar({ slug, canDistribute }: { slug: string; canDistribute: boolean }) {
  const t = useTranslations("cod");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {msg && <span className="text-muted-foreground">{msg}</span>}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await rescoreAction(slug); setMsg(r.ok && r.data ? t("rescored", { n: r.data.scored }) : null); router.refresh(); })}>{t("rescore")}</Button>
      {canDistribute && <Button size="sm" disabled={pending} onClick={() => start(async () => { const r = await distributeAction(slug); setMsg(r.ok && r.data ? t("distributed", r.data) : null); router.refresh(); })} data-testid="distribute">{t("distribute")}</Button>}
    </div>
  );
}
