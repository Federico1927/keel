"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { AD_PLATFORM_LABELS } from "@keel/config";
import { Ban, Pause, Play } from "lucide-react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Select } from "@keel/ui";
import { addNegativeKeywordAction, setAdStatusAction } from "@/server/actions/ads";
import type { ActionResult } from "@/server/action-result";

const PLATFORM_LABEL: Readonly<Record<string, string>> = AD_PLATFORM_LABELS;

/** Pause or resume one ad on the platform, after an explicit confirmation; the write goes through the outbox. */
export function AdStatusButton({ slug, adId, platform, status, canWrite }: { slug: string; adId: string; platform: string; status: string; canWrite: boolean }) {
  const t = useTranslations("ads.actions");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const label = PLATFORM_LABEL[platform] ?? platform;
  if (status === "archived") return null;
  if (!canWrite) return <p className="text-sm text-muted-foreground" data-testid="ads-read-only">{t("read_only", { platform: label })}</p>;
  const next = status === "active" ? "paused" : "active";
  return (
    <>
      {result && !result.ok && <Alert variant="destructive" className="w-full"><AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription></Alert>}
      <Button variant={next === "paused" ? "destructive" : "default"} size="sm" disabled={pending} onClick={() => setOpen(true)}>
        {next === "paused" ? <Pause /> : <Play />} {next === "paused" ? t("pause_ad") : t("resume_ad")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{next === "paused" ? t("pause_title", { platform: label }) : t("resume_title", { platform: label })}</DialogTitle>
            <DialogDescription>{t("write_description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} variant={next === "paused" ? "destructive" : "default"} onClick={() => start(async () => { const r = await setAdStatusAction(slug, adId, next); setResult(r); if (r.ok) setOpen(false); })}>{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Exclude a search term as a negative keyword (match type and level chosen in the dialog); Google stays read-only without the write scope. */
export function NegativeKeywordButton({ slug, termId, text, canWrite, hasAdGroup }: { slug: string; termId: string; text: string; canWrite: boolean; hasAdGroup: boolean }) {
  const t = useTranslations("ads.actions");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [match, setMatch] = useState("exact");
  const [level, setLevel] = useState("campaign");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  if (!canWrite) return <span className="text-xs text-muted-foreground" title={t("read_only", { platform: "Google Ads" })}>{t("read_only_short")}</span>;
  return (
    <>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => setOpen(true)} data-testid="add-negative"><Ban /> {t("exclude")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("negative_title", { text })}</DialogTitle>
            <DialogDescription>{t("negative_description")}</DialogDescription>
          </DialogHeader>
          {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription></Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`m-${termId}`}>{t("match_type")}</Label>
              <Select id={`m-${termId}`} value={match} onChange={(e) => setMatch(e.target.value)}>
                {["exact", "phrase", "broad"].map((m) => <option key={m} value={m}>{t(`match.${m}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`l-${termId}`}>{t("level")}</Label>
              <Select id={`l-${termId}`} value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="campaign">{t("levels.campaign")}</option>
                {hasAdGroup && <option value="ad_group">{t("levels.ad_group")}</option>}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} onClick={() => start(async () => { const r = await addNegativeKeywordAction(slug, termId, match, level); setResult(r); if (r.ok) setOpen(false); })}>{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
