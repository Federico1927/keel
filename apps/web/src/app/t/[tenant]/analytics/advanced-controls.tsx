"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, Label, Select } from "@hullwise/ui";
import { deleteAlertRuleAction, deleteCustomMetricAction, runAlertsNowAction, saveAlertRuleAction, saveCustomMetricAction, saveDashboardAction, saveSlackWebhookAction, toggleAlertRuleAction } from "@/server/actions/analytics";

/** Pick and order the metrics of my dashboard. */
export function DashboardEditor({ slug, options, selected }: { slug: string; options: { key: string; label: string }[]; selected: string[] }) {
  const t = useTranslations("analytics.custom");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(selected);
  const [pending, start] = useTransition();
  if (!open) return <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="edit-dashboard">{t("edit")}</Button>;
  return (
    <div className="w-full space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = sel.includes(o.key);
          return (
            <button key={o.key} type="button" onClick={() => setSel(on ? sel.filter((x) => x !== o.key) : [...sel, o.key])} className={`rounded-full border px-3 py-1 text-sm ${on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`} data-testid={`metric-${o.key}`}>
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => start(async () => { await saveDashboardAction(slug, sel); setOpen(false); router.refresh(); })} data-testid="save-dashboard">{tc("save")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
      </div>
    </div>
  );
}

export function CustomMetricForm({ slug, bases }: { slug: string; bases: string[] }) {
  const t = useTranslations("analytics.custom");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCustomMetricAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-3" data-testid="metric-form">
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_9rem]">
        <div className="space-y-1"><Label htmlFor="cm-label">{t("label")}</Label><Input id="cm-label" name="label" required placeholder={t("label_placeholder")} /></div>
        <div className="space-y-1"><Label htmlFor="cm-formula">{t("formula")}</Label><Input id="cm-formula" name="formula" required placeholder="(net_revenue - ad_spend) / orders" className="font-mono text-sm" /></div>
        <div className="space-y-1"><Label htmlFor="cm-format">{t("format")}</Label><Select id="cm-format" name="format" defaultValue="money">{["money", "ratio", "percent", "number"].map((f) => <option key={f} value={f}>{t(`formats.${f}`)}</option>)}</Select></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("available")} <span className="font-mono">{bases.join(", ")}</span></p>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="save-metric">{t("save_metric")}</Button>
        {state?.ok && <span className="text-xs text-muted-foreground">{tc("saved")}</span>}
        {state && !state.ok && <span className="text-xs text-destructive">{state.error === "invalid_formula" ? `${t("invalid_formula")} ${state.fieldErrors?.detail ?? ""}` : tc(`errors.${state.error}`)}</span>}
      </div>
    </form>
  );
}

export function DeleteMetricButton({ slug, id }: { slug: string; id: string }) {
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await deleteCustomMetricAction(slug, id); router.refresh(); })}>{tc("delete")}</Button>;
}

export function AlertRuleForm({ slug, metrics, members }: { slug: string; metrics: string[]; members: { id: string; label: string }[] }) {
  const t = useTranslations("analytics.alerts");
  const tc = useTranslations("common");
  const [kind, setKind] = useState<"threshold" | "anomaly">("anomaly");
  const [state, action, pending] = useActionState(saveAlertRuleAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-3" data-testid="alert-form">
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="space-y-1"><Label htmlFor="ar-name">{t("name")}</Label><Input id="ar-name" name="name" required /></div>
        <div className="space-y-1"><Label htmlFor="ar-metric">{t("metric")}</Label><Select id="ar-metric" name="metric">{metrics.map((m) => <option key={m} value={m}>{t(`metrics.${m}`)}</option>)}</Select></div>
        <div className="space-y-1"><Label htmlFor="ar-kind">{t("kind")}</Label><Select id="ar-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as "threshold" | "anomaly")}><option value="anomaly">{t("kinds.anomaly")}</option><option value="threshold">{t("kinds.threshold")}</option></Select></div>
      </div>
      {kind === "threshold" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1"><Label htmlFor="ar-op">{t("op")}</Label><Select id="ar-op" name="op"><option value="lt">{t("ops.lt")}</option><option value="gt">{t("ops.gt")}</option></Select></div>
          <div className="space-y-1"><Label htmlFor="ar-value">{t("value")}</Label><Input id="ar-value" name="value" type="number" step="any" required /></div>
          <div className="space-y-1"><Label htmlFor="ar-days">{t("days")}</Label><Input id="ar-days" name="days" type="number" min={1} max={14} defaultValue={1} /></div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1"><Label htmlFor="ar-dir">{t("direction")}</Label><Select id="ar-dir" name="direction" defaultValue="both"><option value="both">{t("directions.both")}</option><option value="up">{t("directions.up")}</option><option value="down">{t("directions.down")}</option></Select></div>
          <div className="space-y-1"><Label htmlFor="ar-sens">{t("sensitivity")}</Label><Input id="ar-sens" name="sensitivity" type="number" step="0.5" min={1} max={6} defaultValue={3} /></div>
          <div className="space-y-1"><Label htmlFor="ar-base">{t("baseline_days")}</Label><Input id="ar-base" name="baselineDays" type="number" min={7} max={90} defaultValue={28} /></div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {(["in_app", "email", "slack"] as const).map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" name={`ch_${c}`} defaultChecked={c === "in_app"} className="h-4 w-4" /> {t(`channels.${c}`)}</label>)}
        <span className="flex items-center gap-1"><Label htmlFor="ar-cool">{t("cooldown")}</Label><Input size="sm" id="ar-cool" name="cooldownHours" type="number" min={1} max={168} defaultValue={24} className="w-20" /></span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ar-rec">{t("recipients")}</Label>
        <Select id="ar-rec" name="recipients" multiple className="h-24">{members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="save-alert">{t("create")}</Button>
        {state?.ok && <span className="text-xs text-muted-foreground">{tc("saved")}</span>}
        {state && !state.ok && <span className="text-xs text-destructive">{tc(`errors.${state.error}`)}</span>}
      </div>
    </form>
  );
}

export function AlertRuleControls({ slug, id, active }: { slug: string; id: string; active: boolean }) {
  const t = useTranslations("analytics.alerts");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <span className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await toggleAlertRuleAction(slug, id, !active); router.refresh(); })}>{active ? t("disable") : t("enable")}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await deleteAlertRuleAction(slug, id); router.refresh(); })}>{tc("delete")}</Button>
    </span>
  );
}

export function RunAlertsButton({ slug }: { slug: string }) {
  const t = useTranslations("analytics.alerts");
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      {msg && <Badge variant="info">{msg}</Badge>}
      <Button size="sm" variant="outline" disabled={pending} data-testid="run-alerts" onClick={() => start(async () => { const r = await runAlertsNowAction(slug); if (r.ok && r.data) setMsg(t("ran", r.data)); router.refresh(); })}>{t("run_now")}</Button>
    </span>
  );
}

export function SlackWebhookForm({ slug, connected }: { slug: string; connected: boolean }) {
  const t = useTranslations("analytics.alerts");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveSlackWebhookAction.bind(null, slug), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="min-w-64 flex-1 space-y-1"><Label htmlFor="slack-url">{t("slack_url")}</Label><Input id="slack-url" name="webhookUrl" placeholder={connected ? t("slack_connected") : "https://hooks.slack.com/services/…"} /></div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{tc("save")}</Button>
      {state?.ok && <span className="text-xs text-muted-foreground">{tc("saved")}</span>}
      {state && !state.ok && <span className="text-xs text-destructive">{tc(`errors.${state.error}`)}</span>}
    </form>
  );
}
