"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, CardContent, Input } from "@keel/ui";
import { submitSurveyAction } from "@/server/actions/survey";

export interface SurveyFormProps {
  slug: string;
  order: string;
  signature: string;
  locale: string;
  question: string;
  thanks: string;
  options: { key: string; label: string }[];
  allowOther: boolean;
  answered: boolean;
}

export function SurveyForm(p: SurveyFormProps) {
  const t = useTranslations("survey_public");
  const [answer, setAnswer] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [done, setDone] = useState(p.answered);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <p className="text-center text-lg" data-testid="survey-done">{p.answered ? t("already") : p.thanks}</p>;
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <h1 className="text-2xl font-semibold">{p.question}</h1>
        <div className="grid gap-2" role="radiogroup" aria-label={p.question}>
          {[...p.options, ...(p.allowOther ? [{ key: "other", label: t("other") }] : [])].map((o) => (
            <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5" data-testid="survey-option">
              <input type="radio" name="answer" value={o.key} checked={answer === o.key} onChange={() => setAnswer(o.key)} />
              {o.label}
            </label>
          ))}
        </div>
        {answer === "other" && <Input value={other} maxLength={300} onChange={(e) => setOther(e.target.value)} placeholder={t("other_placeholder")} aria-label={t("other")} />}
        {error && <p className="text-sm text-destructive">{t(`errors.${error}`)}</p>}
        <Button disabled={!answer || pending} onClick={() => start(async () => { const r = await submitSurveyAction(p.slug, { order: p.order, signature: p.signature, answer, other, locale: p.locale }); if (r.ok) setDone(true); else setError(r.error); })} data-testid="survey-submit">{t("send")}</Button>
      </CardContent>
    </Card>
  );
}
