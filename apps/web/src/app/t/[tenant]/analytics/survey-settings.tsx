"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SUPPORTED_LOCALES } from "@hullwise/config";
import type { SurveyConfig } from "@hullwise/core";
import { Button, Input, Label } from "@hullwise/ui";
import { saveSurveySettingsAction } from "@/server/actions/survey";

/** Survey on/off, blend weight, and the question and option labels in every supported language. */
export function SurveySettings({ slug, enabled, config, canWrite }: { slug: string; enabled: boolean; config: SurveyConfig; canWrite: boolean }) {
  const t = useTranslations("survey_admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [c, setC] = useState<SurveyConfig>(config);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const setLabel = (i: number, locale: string, v: string) => setC({ ...c, options: c.options.map((o, j) => (j === i ? { ...o, labels: { ...o.labels, [locale]: v } } : o)) });
  return (
    <div className="space-y-4" data-testid="survey-settings">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={on} disabled={!canWrite} onChange={(e) => setOn(e.target.checked)} data-testid="survey-enabled" /> {t("enabled")}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.allowOther} disabled={!canWrite} onChange={(e) => setC({ ...c, allowOther: e.target.checked })} /> {t("allow_other")}</label>
        <div className="space-y-1">
          <Label htmlFor="sv-blend">{t("blend")}</Label>
          <Input id="sv-blend" type="number" min={0} max={100} className="w-24" value={c.blendBps / 100} disabled={!canWrite} onChange={(e) => setC({ ...c, blendBps: Math.round(Math.min(100, Math.max(0, Number(e.target.value))) * 100) })} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="p-1">{t("option")}</th>
              {SUPPORTED_LOCALES.map((l) => <th key={l} className="p-1 uppercase">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="p-1 text-xs text-muted-foreground">{t("question")}</td>
              {SUPPORTED_LOCALES.map((l) => <td key={l} className="p-1"><Input value={c.question[l] ?? ""} disabled={!canWrite} onChange={(e) => setC({ ...c, question: { ...c.question, [l]: e.target.value } })} aria-label={`${t("question")} ${l}`} /></td>)}
            </tr>
            {c.options.map((o, i) => (
              <tr key={o.key}>
                <td className="p-1 text-xs"><span className="font-mono">{o.key}</span><span className="block text-muted-foreground">→ {o.channel}</span></td>
                {SUPPORTED_LOCALES.map((l) => <td key={l} className="p-1"><Input value={o.labels[l] ?? ""} disabled={!canWrite} onChange={(e) => setLabel(i, l, e.target.value)} aria-label={`${o.key} ${l}`} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      {canWrite && <Button disabled={pending} onClick={() => start(async () => { const r = await saveSurveySettingsAction(slug, { enabled: on, config: c }); setMsg(r.ok ? t("saved") : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : t(`errors.${r.error}`)); if (r.ok) router.refresh(); })} data-testid="survey-save">{tc("save")}</Button>}
    </div>
  );
}
