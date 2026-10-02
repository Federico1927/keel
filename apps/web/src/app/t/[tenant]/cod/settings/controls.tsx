"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Switch } from "@hullwise/ui";
import type { CodSettings, ScoreFactorKey, TagWriteEvent } from "@hullwise/addon-cod";
import { WideTable } from "@/components/mobile/wide-table";
import { deleteExceptionAction, recomputeRiskAction, saveCapacityAction, saveCodSettingsAction, saveCodTagSettingsAction, saveExceptionAction, setOverrideAction } from "@/server/actions/cod";

export function ScoringSettingsForm({ slug, settings, factors }: { slug: string; settings: CodSettings; factors: readonly ScoreFactorKey[] }) {
  const t = useTranslations("cod.settings");
  const tf = useTranslations("cod.factors");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCodSettingsAction.bind(null, slug), null);
  const numbers: { key: string; value: number }[] = [
    { key: "unreachableAfterAttempts", value: settings.unreachableAfterAttempts },
    { key: "queueCutoffDays", value: settings.queueCutoffDays },
    { key: "timeElapsedWarnHours", value: settings.timeElapsedWarnHours },
    { key: "customerHistoryHalfLifeDays", value: settings.customerHistoryHalfLifeDays },
    { key: "customerHistoryMinOrders", value: settings.customerHistoryMinOrders },
    { key: "similarOrdersLookbackDays", value: settings.similarOrdersLookbackDays },
    { key: "similarOrdersMinSample", value: settings.similarOrdersMinSample },
    { key: "orderValueMultiple", value: settings.orderValueMultiple },
  ];
  const risk: { key: string; value: number }[] = [
    { key: "watchMinReturns", value: settings.risk.watchMinReturns },
    { key: "highRiskMinReturns", value: settings.risk.highRiskMinReturns },
    { key: "blacklistMinReturns", value: settings.risk.blacklistMinReturns },
    { key: "recentMonths", value: settings.risk.recentMonths },
    { key: "redemptionConsecutiveDeliveries", value: settings.risk.redemptionConsecutiveDeliveries },
  ];
  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("weights_title")}</CardTitle>
          <CardDescription>{t("weights_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {factors.map((f) => (
            <div key={f} className="space-y-1">
              <Label htmlFor={`w_${f}`} className="flex justify-between"><span>{tf(`${f}.name`)}</span><span className="tabular text-muted-foreground">{settings.weights[f]}</span></Label>
              <Input id={`w_${f}`} name={`w_${f}`} type="number" min={0} max={50} defaultValue={settings.weights[f]} />
              <p className="text-xs text-muted-foreground">{tf(`${f}.help`)}</p>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("thresholds_title")}</CardTitle>
          <CardDescription>{t("thresholds_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {numbers.map((n) => (
            <div key={n.key} className="space-y-1">
              <Label htmlFor={n.key}>{t(`fields.${n.key}`)}</Label>
              <Input id={n.key} name={n.key} type="number" step="any" defaultValue={n.value} />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("risk_title")}</CardTitle>
          <CardDescription>{t("risk_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {risk.map((n) => (
            <div key={n.key} className="space-y-1">
              <Label htmlFor={`risk_${n.key}`}>{t(`fields.risk_${n.key}`)}</Label>
              <Input id={`risk_${n.key}`} name={`risk_${n.key}`} type="number" step="any" defaultValue={n.value} />
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{tc("save")}</Button>
        {state?.ok && <span className="text-sm text-muted-foreground">{tc("saved")}</span>}
        {state && !state.ok && (
          <Alert variant="destructive" className="flex-1"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>
        )}
      </div>
    </form>
  );
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function CapacityRow({ slug, userId, label, dailyHours, isActive, allowedTags }: { slug: string; userId: string; label: string; dailyHours: number[]; isActive: boolean; allowedTags: string[] }) {
  const t = useTranslations("cod.settings");
  const router = useRouter();
  const [hours, setHours] = useState<number[]>(Array.from({ length: 7 }, (_, i) => dailyHours[i] ?? 0));
  const [active, setActive] = useState(isActive);
  const [tags, setTags] = useState(allowedTags.join(", "));
  const [pending, start] = useTransition();
  const parseTags = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);
  const save = (h: number[], a: boolean, tg = tags) => start(async () => { await saveCapacityAction(slug, userId, h, a, parseTags(tg)); router.refresh(); });
  return (
    <tr className="border-b text-sm" data-testid="capacity-row">
      <td className="px-3 py-2">{label}</td>
      {DAYS.map((d, i) => (
        <td key={d} className="px-1 py-2">
          <Input size="sm" type="number" min={0} max={24} className="w-14 text-center" value={hours[i]} aria-label={`${label} ${t(`days.${d}`)}`} onChange={(e) => { const next = [...hours]; next[i] = Number(e.target.value) || 0; setHours(next); }} onBlur={() => save(hours, active)} />
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular">{hours.reduce((s, h) => s + h, 0)}</td>
      <td className="px-3 py-2"><Input size="sm" className="min-w-36" value={tags} placeholder={t("allowed_tags_any")} aria-label={`${label} ${t("allowed_tags")}`} onChange={(e) => setTags(e.target.value)} onBlur={() => save(hours, active, tags)} /></td>
      <td className="px-3 py-2 text-right"><Switch checked={active} disabled={pending} onCheckedChange={(v) => { setActive(v); save(hours, v); }} aria-label={t("active")} /></td>
    </tr>
  );
}

export function ExceptionForm({ slug, operators }: { slug: string; operators: { id: string; label: string }[] }) {
  const t = useTranslations("cod.settings");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveExceptionAction.bind(null, slug), null);
  const [kind, setKind] = useState("off");
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_9rem_7rem_6rem_1fr_auto] sm:items-end">
      <div className="space-y-1"><Label htmlFor="ex-user">{t("operator")}</Label><Select id="ex-user" name="userId">{operators.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="ex-date">{t("date")}</Label><Input id="ex-date" name="date" type="date" required /></div>
      <div className="space-y-1"><Label htmlFor="ex-kind">{t("kind")}</Label><Select id="ex-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="off">{t("kinds.off")}</option><option value="extra">{t("kinds.extra")}</option></Select></div>
      <div className="space-y-1"><Label htmlFor="ex-hours">{t("hours")}</Label><Input id="ex-hours" name="hours" type="number" min={0} max={24} disabled={kind !== "extra"} /></div>
      <div className="space-y-1"><Label htmlFor="ex-note">{t("note")}</Label><Input id="ex-note" name="note" /></div>
      <Button type="submit" size="sm" disabled={pending}>{tc("save")}</Button>
      {state && !state.ok && <p className="text-sm text-destructive sm:col-span-6">{tc(`errors.${state.error}`)}</p>}
    </form>
  );
}

export function DeleteExceptionButton({ slug, id }: { slug: string; id: string }) {
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await deleteExceptionAction(slug, id); router.refresh(); })}>{tc("delete")}</Button>;
}

export function RecomputeRiskButton({ slug }: { slug: string }) {
  const t = useTranslations("cod.settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2 text-sm">
      {msg && <span className="text-muted-foreground">{msg}</span>}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await recomputeRiskAction(slug); setMsg(r.ok && r.data ? t("risk_recomputed", r.data) : null); router.refresh(); })}>{t("recompute_risk")}</Button>
    </span>
  );
}

export function OverrideControls({ slug, recipientKey, override }: { slug: string; recipientKey: string; override: string | null }) {
  const t = useTranslations("cod.settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const apply = (o: "force_clean" | "force_blacklist" | null) => start(async () => { await setOverrideAction(slug, recipientKey, o, o ? reason : null); setReason(""); router.refresh(); });
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {override ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => apply(null)}>{t("clear_override")}</Button>
      ) : (
        <>
          <Input size="sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("override_reason")} className="w-40" />
          <Button size="sm" variant="outline" disabled={pending || reason.trim().length < 5} onClick={() => apply("force_blacklist")}>{t("force_blacklist")}</Button>
          <Button size="sm" variant="ghost" disabled={pending || reason.trim().length < 5} onClick={() => apply("force_clean")}>{t("force_clean")}</Button>
        </>
      )}
    </div>
  );
}

/** Which platform tags the queue reads and which it writes, per event. Comma-separated; `*` matches a prefix. */
export function TagSettingsForm({ slug, settings, events }: { slug: string; settings: CodSettings; events: readonly TagWriteEvent[] }) {
  const t = useTranslations("cod.settings");
  const to = useTranslations("cod");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCodTagSettingsAction.bind(null, slug), null);
  const join = (xs: string[]) => xs.join(", ");
  const reads: { key: "queue" | "confirmed" | "cancelled" }[] = [{ key: "queue" }, { key: "confirmed" }, { key: "cancelled" }];
  return (
    <form action={action} className="space-y-6" data-testid="tag-settings">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("tags_title")}</CardTitle>
          <CardDescription>{t("tags_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <p className="mb-2 text-sm font-medium">{t("tags_read_title")}</p>
            <div className="grid gap-3 lg:grid-cols-3">
              {reads.map((r) => (
                <div key={r.key} className="space-y-1">
                  <Label htmlFor={`tags_${r.key}`}>{t(`tags_read.${r.key}`)}</Label>
                  <Input id={`tags_${r.key}`} name={`tags_${r.key}`} defaultValue={join(settings.tags[r.key])} placeholder={t("tags_placeholder")} />
                  <p className="text-xs text-muted-foreground">{t(`tags_read_help.${r.key}`)}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">{t("tags_write_title")}</p>
            <p className="mb-2 text-xs text-muted-foreground">{t("tags_write_help")}</p>
            <WideTable label={t("tags_write_title")} stickyFirst>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-2">{t("tags_event")}</th>
                    <th className="px-3 py-2">{t("tags_add")}</th>
                    <th className="px-3 py-2">{t("tags_remove")}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e} className="border-b">
                      <td className="px-3 py-2 whitespace-nowrap">{e === "entered" ? t("tags_event_entered") : e === "replaced" ? t("tags_event_replaced") : e === "unreachable" ? to("queue_status.unreachable") : to(`outcomes.${e}`)}</td>
                      <td className="min-w-40 px-3 py-2"><Input name={`w_add_${e}`} aria-label={`${t("tags_add")} ${e}`} defaultValue={join(settings.tags.write[e].add)} /></td>
                      <td className="min-w-40 px-3 py-2"><Input name={`w_remove_${e}`} aria-label={`${t("tags_remove")} ${e}`} defaultValue={join(settings.tags.write[e].remove)} /></td>
                    </tr>
                  ))}
                </tbody>
            </WideTable>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="clearQueueTagsOnClose" defaultChecked={settings.tags.clearQueueTagsOnClose} className="h-4 w-4" /> {t("tags_clear_on_close")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="cancelRestock" defaultChecked={settings.cancelRestock} className="h-4 w-4" /> {t("cancel_restock")}</label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending} data-testid="save-tags">{tc("save")}</Button>
            {state?.ok && <span className="text-sm text-muted-foreground">{tc("saved")}</span>}
            {state && !state.ok && <Alert variant="destructive" className="flex-1"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
