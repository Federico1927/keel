"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import type { AccountingSettings } from "@hullwise/core";
import type { ActionResult } from "@/server/action-result";
import { connectAccountingAction, repushAccountingDayAction, retryAccountingDayAction, runAccountingNowAction, saveAccountingSettingsAction } from "@/server/actions/accounting";

/* Client controls of the addon.accounting pages (#85). */

function useMessage() {
  const t = useTranslations("accounting");
  const tc = useTranslations("common");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const say = (r: ActionResult<unknown>, okText: string) => setMsg(r.ok ? { tone: "ok", text: okText } : { tone: "err", text: (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`, { accounts: r.fieldErrors?.accounts ?? "" }) : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : "") });
  const view = msg ? <Alert variant={msg.tone === "err" ? "destructive" : "default"}><AlertDescription data-testid="accounting-message">{msg.text}</AlertDescription></Alert> : null;
  return { say, view, clear: () => setMsg(null) };
}

/** "Push now": runs the hourly tick for this store. */
export function RunNowButton({ slug }: { slug: string }) {
  const t = useTranslations("accounting.log");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  return (
    <div className="space-y-2">
      <Button size="sm" disabled={pending} data-testid="accounting-run" onClick={() => start(async () => { const r = await runAccountingNowAction(slug); say(r, r.ok && r.data ? t("run_done", { pushed: r.data.pushed, waiting: r.data.waiting, failed: r.data.failed }) : ""); router.refresh(); })}>{t("run")}</Button>
      {view}
    </div>
  );
}

/** Retry for a failed or waiting day; re-push (void and replace, confirmed) for a pushed one. */
export function DayActions({ slug, day, dayLabel, status, version }: { slug: string; day: string; dayLabel: string; status: string; version: number }) {
  const t = useTranslations("accounting.log");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view, clear } = useMessage();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-1">
      {(status === "failed" || status === "waiting") && <Button size="sm" variant="outline" disabled={pending} data-testid="accounting-retry" onClick={() => start(async () => { const r = await retryAccountingDayAction(slug, day); say(r, r.ok && r.data ? (r.data.pushed ? t("retry_pushed") : r.data.failed ? t("retry_failed") : t("retry_waiting")) : ""); router.refresh(); })}>{t("retry")}</Button>}
      {status === "pushed" && <Button size="sm" variant="outline" disabled={pending} data-testid="accounting-repush" onClick={() => { clear(); setNote(""); setOpen(true); }}>{t("repush")}</Button>}
      {view}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("repush_title", { day: dayLabel })}</DialogTitle>
            <DialogDescription>{t("repush_description", { version, next: version + 1 })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor={`repush-note-${day}`}>{t("repush_note")}</Label>
            <Textarea id={`repush-note-${day}`} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button disabled={pending} data-testid="accounting-repush-confirm" onClick={() => start(async () => { const r = await repushAccountingDayAction(slug, day, note || null); say(r, r.ok && r.data ? (r.data.status === "pushed" ? t("repush_done", { version: r.data.version }) : t("repush_not_pushed", { version: r.data.version })) : ""); if (r.ok) setOpen(false); router.refresh(); })}>{t("repush_confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Connection buttons of the integration card: connect (mock), test, resync the chart of accounts, simulate a refusal. */
/** The connect path of the accounting sheet (test, resync and the simulated refusal are on the shared card, #90). */
export function AccountingConnection({ slug, mock, canManage }: { slug: string; mock: boolean; canManage: boolean }) {
  const t = useTranslations("accounting.connection");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  if (!canManage) return null;
  const run = (fn: () => Promise<void>) => start(async () => { await fn(); router.refresh(); });
  return (
    <div className="space-y-2">
      <Button size="sm" disabled={pending} data-testid="accounting-connect" onClick={() => run(async () => { const r = await connectAccountingAction(slug); say(r, r.ok && r.data ? t("connected", { n: r.data.accounts }) : ""); })}>{mock ? t("connect_mock") : t("connect")}</Button>
      {view}
    </div>
  );
}

/** The account mapping and push settings; codes come from the chart of accounts last read (free text when none was read). */
export function MappingForm({ slug, settings, accounts, rateKeys, rateLabels }: { slug: string; settings: AccountingSettings; accounts: { code: string; name: string; active: boolean }[]; rateKeys: string[]; rateLabels: Record<string, string> }) {
  const t = useTranslations("accounting.settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  const [form, setForm] = useState<AccountingSettings>(() => ({ ...settings, mapping: { ...settings.mapping, byRate: Object.fromEntries(rateKeys.map((k) => [k, { sales: settings.mapping.byRate[k]?.sales ?? null, tax: settings.mapping.byRate[k]?.tax ?? null }])) } }));
  const lines = ["sales", "tax", "shipping", "discounts", "refunds", "fees", "clearing"] as const;
  const active = accounts.filter((a) => a.active);
  const picker = (id: string, value: string | null, onChange: (v: string | null) => void, allowDefault: boolean) =>
    active.length ? (
      <Select id={id} size="sm" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} data-testid={id}>
        <option value="">{allowDefault ? t("use_default") : t("not_mapped")}</option>
        {active.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
      </Select>
    ) : (
      <Input id={id} size="sm" value={value ?? ""} placeholder={allowDefault ? t("use_default") : t("not_mapped")} onChange={(e) => onChange(e.target.value.trim() || null)} data-testid={id} />
    );
  const save = () => start(async () => {
    const byRate = Object.fromEntries(Object.entries(form.mapping.byRate).filter(([, v]) => v.sales || v.tax));
    const r = await saveAccountingSettingsAction(slug, { ...form, mapping: { ...form.mapping, byRate } });
    say(r, t("saved"));
    router.refresh();
  });
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save(); }} data-testid="accounting-mapping">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {lines.map((l) => (
          <div key={l} className="space-y-1">
            <Label htmlFor={`map-${l}`}>{t(`lines.${l}`)}</Label>
            {picker(`map-${l}`, form.mapping[l], (v) => setForm({ ...form, mapping: { ...form.mapping, [l]: v } }), false)}
            <p className="text-xs text-muted-foreground">{t(`hints.${l}`)}</p>
          </div>
        ))}
      </div>
      {rateKeys.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("by_rate")}</h3>
          <p className="text-xs text-muted-foreground">{t("by_rate_hint")}</p>
          <div className="space-y-3">
            {rateKeys.map((k) => (
              <div key={k} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-end" data-testid="rate-row">
                <span className="text-sm font-medium">{rateLabels[k] ?? k}</span>
                <div className="space-y-1"><Label htmlFor={`rate-${k}-sales`}>{t("lines.sales")}</Label>{picker(`rate-${k}-sales`, form.mapping.byRate[k]?.sales ?? null, (v) => setForm({ ...form, mapping: { ...form.mapping, byRate: { ...form.mapping.byRate, [k]: { sales: v, tax: form.mapping.byRate[k]?.tax ?? null } } } }), true)}</div>
                <div className="space-y-1"><Label htmlFor={`rate-${k}-tax`}>{t("lines.tax")}</Label>{picker(`rate-${k}-tax`, form.mapping.byRate[k]?.tax ?? null, (v) => setForm({ ...form, mapping: { ...form.mapping, byRate: { ...form.mapping.byRate, [k]: { sales: form.mapping.byRate[k]?.sales ?? null, tax: v } } } }), true)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1"><Label htmlFor="acc-start">{t("start_day")}</Label><Input id="acc-start" size="sm" type="date" value={form.startDay ?? ""} onChange={(e) => setForm({ ...form, startDay: e.target.value || null })} /><p className="text-xs text-muted-foreground">{t("start_day_hint")}</p></div>
        <div className="space-y-1"><Label htmlFor="acc-lookback">{t("lookback")}</Label><Input id="acc-lookback" size="sm" type="number" min={1} max={90} value={form.lookbackDays} onChange={(e) => setForm({ ...form, lookbackDays: Number(e.target.value) || 1 })} /></div>
        <div className="space-y-1"><Label htmlFor="acc-delay">{t("close_delay")}</Label><Input id="acc-delay" size="sm" type="number" min={0} max={48} value={form.closeDelayHours} onChange={(e) => setForm({ ...form, closeDelayHours: Math.max(0, Number(e.target.value) || 0) })} /><p className="text-xs text-muted-foreground">{t("close_delay_hint")}</p></div>
        <div className="space-y-1"><Label htmlFor="acc-status">{t("journal_status")}</Label><Select id="acc-status" size="sm" value={form.journalStatus} onChange={(e) => setForm({ ...form, journalStatus: e.target.value as AccountingSettings["journalStatus"] })}>{(["draft", "posted"] as const).map((s) => <option key={s} value={s}>{t(`journal_statuses.${s}`)}</option>)}</Select></div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="accounting-save">{t("save")}</Button>
        {view}
      </div>
    </form>
  );
}
