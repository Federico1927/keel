"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Switch, Textarea } from "@keel/ui";
import type { CodSettings, MessageTemplate, ScoreFactor } from "@keel/addon-cod";
import { importCarrierAction, previewScoreAction, saveCodOperationsAction, saveCodTemplatesAction } from "@/server/actions/cod";
import { CopyButton } from "../queue-extras";

/** Queue behaviour (C.2, C.5, C.9, C.11, C.13, C.14) and the return-to-sender automation. */
export function OperationsForm({ slug, settings, currencyDecimals }: { slug: string; settings: CodSettings; currencyDecimals: number }) {
  const t = useTranslations("cod.settings.ops");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCodOperationsAction.bind(null, slug), null);
  const nums: { key: keyof CodSettings; value: number; step?: string }[] = [
    { key: "agingWarnHours", value: settings.agingWarnHours },
    { key: "agingAlertHours", value: settings.agingAlertHours },
    { key: "scheduledConfirmHour", value: settings.scheduledConfirmHour },
    { key: "transferDailyLimit", value: settings.transferDailyLimit },
    { key: "bottleneckFactor", value: settings.bottleneckFactor, step: "0.1" },
  ];
  return (
    <form action={action} data-testid="ops-settings">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {nums.map((n) => (
              <div key={n.key} className="space-y-1">
                <Label htmlFor={`ops-${n.key}`}>{t(`fields.${n.key}`)}</Label>
                <Input id={`ops-${n.key}`} name={n.key} type="number" step={n.step ?? "1"} min={0} defaultValue={n.value} />
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ops-fee">{t("fields.feeLineMatch")}</Label>
              <Input id="ops-fee" name="feeLineMatch" defaultValue={settings.feeLineMatch.join(", ")} placeholder="COD-FEE, Contrassegno*" />
              <p className="text-xs text-muted-foreground">{t("fee_help")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ops-refusal">{t("fields.refusalCostMinor")}</Label>
              <Input id="ops-refusal" name="refusalCostMinor" type="number" min={0} defaultValue={settings.refusalCostMinor} />
              <p className="text-xs text-muted-foreground">{t("refusal_help", { decimals: currencyDecimals })}</p>
            </div>
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3">
            <Switch name="rtsAutoCancel" defaultChecked={settings.rtsAutoCancel} aria-label={t("rts_label")} data-testid="rts-toggle" />
            <span className="text-sm"><span className="font-medium">{t("rts_label")}</span><span className="block text-xs text-muted-foreground">{t("rts_help")}</span></span>
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending} data-testid="save-ops">{tc("save")}</Button>
            {state?.ok && <span className="text-sm text-muted-foreground">{tc("saved")}</span>}
            {state && !state.ok && <Alert variant="destructive" className="flex-1"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/** Confirmation message templates with variables (C.17). */
export function TemplatesEditor({ slug, templates, variables, webhookUrl }: { slug: string; templates: MessageTemplate[]; variables: readonly string[]; webhookUrl: string }) {
  const t = useTranslations("cod.settings.templates");
  const tc = useTranslations("common");
  const router = useRouter();
  const [list, setList] = useState<MessageTemplate[]>(templates);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const set = (i: number, patch: Partial<MessageTemplate>) => setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Card data-testid="templates-editor">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("variables")} {variables.map((v) => <code key={v} className="mr-1 rounded bg-muted px-1">{`{{${v}}}`}</code>)}</p>
        {list.map((x, i) => (
          <div key={i} className="space-y-2 rounded-md border p-3" data-testid="template-row">
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <Input aria-label={t("key")} value={x.key} onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "_") })} placeholder="conferma" />
              <Input aria-label={t("name")} value={x.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={t("name")} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setList(list.filter((_, j) => j !== i))}>{t("remove")}</Button>
            </div>
            <Textarea aria-label={t("body")} rows={3} value={x.body} onChange={(e) => set(i, { body: e.target.value })} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setList([...list, { key: `template_${list.length + 1}`, name: "", body: "" }])} data-testid="template-add">{t("add")}</Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await saveCodTemplatesAction(slug, list);
                setResult(r);
                if (r.ok) router.refresh();
              })
            }
            data-testid="templates-save"
          >
            {tc("save")}
          </Button>
          {result?.ok && <span className="text-sm text-muted-foreground">{tc("saved")}</span>}
          {result && !result.ok && <span className="text-sm text-destructive">{tc(`errors.${result.error}`)}</span>}
        </div>
        <div className="rounded-md bg-muted/40 p-2 text-xs">
          <p className="mb-1 font-medium">{t("webhook_title")}</p>
          <p className="mb-1 text-muted-foreground">{t("webhook_help")}</p>
          <div className="flex flex-wrap items-center gap-2"><code className="break-all">{webhookUrl}</code><CopyButton text={webhookUrl} label={t("copy")} /></div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Delivery score of any order by number, without storing it (C.15). */
export function ScorePreview({ slug }: { slug: string }) {
  const t = useTranslations("cod.settings.preview");
  const tf = useTranslations("cod.factors");
  const tcod = useTranslations("cod");
  const tc = useTranslations("common");
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: true; data: { orderId: string; name: string; score: number; base: number; riskTier: string | null; factors: ScoreFactor[] } } | { ok: false; error: string } | null>(null);
  const band = (s: number) => (s >= 75 ? "likely" : s >= 40 ? "uncertain" : "unlikely");
  return (
    <Card data-testid="score-preview">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await previewScoreAction(slug, q);
              setRes(r.ok && r.data ? { ok: true, data: r.data } : { ok: false, error: r.ok ? "invalid_input" : r.error });
            });
          }}
        >
          <Input aria-label={t("order")} placeholder={t("order")} value={q} onChange={(e) => setQ(e.target.value)} className="w-48" data-testid="preview-order" />
          <Button type="submit" size="sm" disabled={pending || !q.trim()} data-testid="preview-run">{t("run")}</Button>
        </form>
        {res && !res.ok && <p className="text-sm text-destructive">{tc(`errors.${res.error}`)}</p>}
        {res?.ok && (
          <div className="space-y-2 text-sm" data-testid="preview-result">
            <p className="flex flex-wrap items-center gap-2">
              <a href={`/t/${slug}/orders/${res.data.orderId}`} className="font-medium text-primary hover:underline">{res.data.name}</a>
              <Badge variant={band(res.data.score) === "likely" ? "success" : band(res.data.score) === "uncertain" ? "warning" : "destructive"} data-testid="preview-score">{res.data.score} · {tcod(`score.${band(res.data.score)}`)}</Badge>
              {res.data.base !== res.data.score && <span className="text-xs text-muted-foreground">{t("base", { n: res.data.base })}</span>}
              {res.data.riskTier && res.data.riskTier !== "clean" && <Badge variant="destructive">{tcod(`risk.${res.data.riskTier}`)}</Badge>}
            </p>
            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {res.data.factors.filter((f) => f.contributes).map((f) => <li key={f.key}><Badge variant="outline" className="mr-1">{f.raw}</Badge>{tf(`${f.key}.name`)}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Carrier billing / remittance import (C.19). */
export function CarrierImportForm({ slug, batches }: { slug: string; batches: { batch: string; at: string; rows: number; matched: number; refused: number }[] }) {
  const t = useTranslations("cod.settings.carrier");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(importCarrierAction.bind(null, slug), null);
  return (
    <Card data-testid="carrier-import">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={action} className="space-y-2">
          <Input type="file" name="file" accept=".csv,text/csv,text/plain" aria-label={t("file")} />
          <Textarea name="csv" rows={4} placeholder={"order;esito;data;costo\n#NW-1001;consegnato;03/09/2026;6,90"} aria-label={t("paste")} data-testid="carrier-csv" />
          <p className="text-xs text-muted-foreground">{t("format")}</p>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={pending} data-testid="carrier-submit">{t("import")}</Button>
            {state?.ok && state.data && <span className="text-sm text-muted-foreground" data-testid="carrier-result">{t("result", state.data)}</span>}
            {state && !state.ok && <span className="text-sm text-destructive">{tc(`errors.${state.error}`)}</span>}
          </div>
        </form>
        {batches.length > 0 && (
          <ul className="divide-y text-xs">
            {batches.map((b) => <li key={b.batch} className="flex flex-wrap justify-between gap-2 py-1"><span className="font-mono">{b.batch}</span><span className="text-muted-foreground">{b.at}</span><span>{t("batch_counts", { rows: b.rows, matched: b.matched, refused: b.refused })}</span></li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
