"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Check, Hand, Send, SkipForward, Undo2, X } from "lucide-react";
import { EXCEPTION_RESOLUTIONS, formatDateTime, type ExceptionResolution, type RtsSuggestion } from "@hullwise/core";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import { claimCaseAction, closeCaseAction, followUpAction, releaseCaseAction, sendInstructionAction } from "@/server/actions/fulfilment";
import type { ActionResult } from "@/server/action-result";

interface CaseData {
  id: string;
  kind: "exception" | "return_to_sender";
  status: string;
  claimedBy: string | null;
  claimedByName: string | null;
  resolution: string | null;
  resolutionDetail: { pickupPoint?: string | null; note?: string | null; address?: Record<string, string | null> | null };
  instructionChannel: string | null;
  instructionTo: string | null;
  instructionSentAt: string | null;
  instructionSentByName: string | null;
  closedAt: string | null;
  closeReason: string | null;
  closedByName: string | null;
  note: string | null;
  followUps: Record<string, { outcome: string; at: string }>;
}

export function CaseActions({ slug, canWrite, isManager, me, locale, timezone, defaultEmail, defaultCountry, orderId, caseData: c, suggestions }: { slug: string; canWrite: boolean; isManager: boolean; me: string; locale: string; timezone: string; defaultEmail: string | null; defaultCountry: string; orderId: string; caseData: CaseData; suggestions: RtsSuggestion[] }) {
  const t = useTranslations("fulfilment_cases");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const mine = c.claimedBy === me;
  const closed = Boolean(c.closedAt);
  const act = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : r.error);
      router.refresh();
    });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.owner")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {closed ? (
            <p data-testid="case-closed">{t("detail.closed", { reason: t(`close_reasons.${c.closeReason ?? "resolved"}`), time: formatDateTime(c.closedAt, locale, timezone) })}{c.closedByName ? ` · ${c.closedByName}` : ""}</p>
          ) : c.claimedBy ? (
            <p data-testid="case-owner">{mine ? t("detail.claimed_by_you") : t("detail.claimed_by_other", { name: c.claimedByName ?? "—" })}</p>
          ) : (
            <p className="text-muted-foreground" data-testid="case-owner">{t("unclaimed")}</p>
          )}
          {canWrite && !closed && (
            <div className="flex flex-wrap gap-2">
              {!c.claimedBy && <Button size="sm" disabled={pending} onClick={() => act(() => claimCaseAction(slug, c.id))} data-testid="claim"><Hand /> {t("detail.claim")}</Button>}
              {c.claimedBy && (mine || isManager) && <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => releaseCaseAction(slug, c.id))} data-testid="release"><Undo2 /> {t("detail.release")}</Button>}
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription data-testid="case-error">{t(`errors.${error}`)}</AlertDescription></Alert>}
        </CardContent>
      </Card>
      {c.kind === "exception" ? (
        <InstructionCard slug={slug} c={c} canAct={canWrite && !closed && mine} locale={locale} timezone={timezone} defaultEmail={defaultEmail} defaultCountry={defaultCountry} />
      ) : (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.follow_ups_title")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">{t("detail.follow_ups_hint")}</p>
            {suggestions.map((s) => {
              const done = c.followUps[s.kind];
              return (
                <div key={s.kind} className="rounded-md border p-2" data-testid={`follow-up-${s.kind}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{t(`follow_ups.${s.kind}`)}</span>
                    {done ? <Badge variant={done.outcome === "done" ? "success" : "muted"}>{t(`outcomes.${done.outcome}`)}</Badge> : s.suggested ? <Badge variant="warning">{t("suggested")}</Badge> : <Badge variant="muted">{t("not_needed")}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{t(`follow_up_reasons.${s.reason}`)}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.kind === "restock" && <Button asChild size="sm" variant="ghost"><Link href={`/t/${slug}/returns/new?order=${orderId}`}>{t("links.restock")}</Link></Button>}
                    {s.kind === "refund" && <Button asChild size="sm" variant="ghost"><Link href={`/t/${slug}/orders/${orderId}`}>{t("links.order")}</Link></Button>}
                    {canWrite && !closed && (!c.claimedBy || mine) && (done ? (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => followUpAction(slug, c.id, s.kind, null))}><Undo2 /> {t("undo")}</Button>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => followUpAction(slug, c.id, s.kind, "done"))} data-testid={`follow-up-${s.kind}-done`}><Check /> {t("mark_done")}</Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => followUpAction(slug, c.id, s.kind, "skipped"))}><SkipForward /> {t("skip")}</Button>
                      </>
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t("detail.cod_note")}</p>
          </CardContent>
        </Card>
      )}
      {canWrite && !closed && (!c.claimedBy || mine) && (
        <Card>
          <CardContent className="flex flex-wrap gap-2 pt-6">
            {c.kind === "return_to_sender" && <Button size="sm" disabled={pending} onClick={() => act(() => closeCaseAction(slug, c.id, "resolved"))} data-testid="close-review"><Check /> {t("detail.close_review")}</Button>}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => closeCaseAction(slug, c.id, "dismissed"))} data-testid="dismiss"><X /> {t("detail.dismiss")}</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InstructionCard({ slug, c, canAct, locale, timezone, defaultEmail, defaultCountry }: { slug: string; c: CaseData; canAct: boolean; locale: string; timezone: string; defaultEmail: string | null; defaultCountry: string }) {
  const t = useTranslations("fulfilment_cases");
  const router = useRouter();
  const [resolution, setResolution] = useState<ExceptionResolution>("redeliver");
  const [channel, setChannel] = useState<"carrier" | "email">("carrier");
  const [emailTo, setEmailTo] = useState(defaultEmail ?? "");
  const [pickupPoint, setPickupPoint] = useState("");
  const [note, setNote] = useState("");
  const [addr, setAddr] = useState({ name: "", address1: "", address2: "", zip: "", city: "", province: "", country: defaultCountry, phone: "" });
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  if (c.instructionSentAt) {
    const d = c.resolutionDetail;
    return (
      <Card data-testid="instruction-sent">
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.instruction_title")}</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><Badge variant="info">{t(`resolutions.${c.resolution ?? "redeliver"}`)}</Badge></p>
          <p>{t("detail.sent", { time: formatDateTime(c.instructionSentAt, locale, timezone), name: c.instructionSentByName ?? "—", channel: t(`channels.${c.instructionChannel ?? "email"}`) })}</p>
          {c.instructionTo && <p className="text-xs text-muted-foreground">{c.instructionTo}</p>}
          {d.pickupPoint && <p className="text-xs">{d.pickupPoint}</p>}
          {d.address && <p className="text-xs">{[d.address.name, d.address.address1, [d.address.zip, d.address.city].filter(Boolean).join(" "), d.address.country].filter(Boolean).join(", ")}</p>}
          {d.note && <p className="text-xs italic">{d.note}</p>}
          <p className="text-xs text-muted-foreground">{t("detail.waiting")}</p>
        </CardContent>
      </Card>
    );
  }
  const set = (k: keyof typeof addr) => (e: React.ChangeEvent<HTMLInputElement>) => setAddr({ ...addr, [k]: e.target.value });
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.instruction_title")}</CardTitle></CardHeader>
      <CardContent>
        {!canAct ? (
          <p className="text-sm text-muted-foreground" data-testid="instruction-locked">{t("detail.claim_first")}</p>
        ) : (
          <form
            className="space-y-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await sendInstructionAction(slug, c.id, { resolution, channel, emailTo: channel === "email" ? emailTo : null, pickupPoint: resolution === "pickup_point" ? pickupPoint : null, note: note || null, address: resolution === "new_address" ? { ...addr, address2: addr.address2 || null, province: addr.province || null, phone: addr.phone || null } : null });
                setResult(r);
                router.refresh();
              });
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="resolution">{t("detail.resolution")}</Label>
              <Select id="resolution" value={resolution} onChange={(e) => setResolution(e.target.value as ExceptionResolution)}>
                {EXCEPTION_RESOLUTIONS.map((r) => <option key={r} value={r}>{t(`resolutions.${r}`)}</option>)}
              </Select>
            </div>
            {resolution === "pickup_point" && (
              <div className="space-y-1">
                <Label htmlFor="pickup">{t("detail.pickup_point")}</Label>
                <Input id="pickup" value={pickupPoint} maxLength={200} onChange={(e) => setPickupPoint(e.target.value)} />
              </div>
            )}
            {resolution === "new_address" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2 space-y-1"><Label htmlFor="a-name">{t("address.name")}</Label><Input id="a-name" value={addr.name} onChange={set("name")} /></div>
                <div className="col-span-2 space-y-1"><Label htmlFor="a-1">{t("address.address1")}</Label><Input id="a-1" value={addr.address1} onChange={set("address1")} /></div>
                <div className="col-span-2 space-y-1"><Label htmlFor="a-2">{t("address.address2")}</Label><Input id="a-2" value={addr.address2} onChange={set("address2")} /></div>
                <div className="space-y-1"><Label htmlFor="a-zip">{t("address.zip")}</Label><Input id="a-zip" value={addr.zip} onChange={set("zip")} /></div>
                <div className="space-y-1"><Label htmlFor="a-city">{t("address.city")}</Label><Input id="a-city" value={addr.city} onChange={set("city")} /></div>
                <div className="space-y-1"><Label htmlFor="a-prov">{t("address.province")}</Label><Input id="a-prov" value={addr.province} onChange={set("province")} /></div>
                <div className="space-y-1"><Label htmlFor="a-country">{t("address.country")}</Label><Input id="a-country" value={addr.country} maxLength={2} onChange={set("country")} /></div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="note">{t("detail.note")}</Label>
              <Textarea id="note" value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="channel">{t("detail.channel")}</Label>
              <Select id="channel" value={channel} onChange={(e) => setChannel(e.target.value as "carrier" | "email")}>
                <option value="carrier">{t("channels.carrier")}</option>
                <option value="email">{t("channels.email")}</option>
              </Select>
            </div>
            {channel === "email" && (
              <div className="space-y-1">
                <Label htmlFor="email-to">{t("detail.email_to")}</Label>
                <Input id="email-to" type="email" value={emailTo} maxLength={200} onChange={(e) => setEmailTo(e.target.value)} />
              </div>
            )}
            {result && !result.ok && <Alert variant="destructive"><AlertDescription data-testid="instruction-error">{t(`errors.${result.error}`)}{result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : ""}</AlertDescription></Alert>}
            <Button type="submit" disabled={pending} data-testid="send-instruction"><Send /> {t("detail.send")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
