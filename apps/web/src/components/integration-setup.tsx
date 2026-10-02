"use client";
// i18n-client-namespaces: integration_setup, integration_guide (guide.namespace is integration_setup.<provider>)
import Link from "next/link";
import { startTransition, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { IntegrationSetupGuide } from "@hullwise/config";
import { Alert, AlertDescription, Badge, Input, Label, cn } from "@hullwise/ui";
import { CopyButton } from "@/app/t/[tenant]/cod/queue-extras";

/**
 * A merchant self-setup checklist rendered from plain data (`IntegrationSetupGuide` in @hullwise/config,
 * #86 GA4, #89 Shopify): numbered steps from message keys (an optional title, the text), a copy button for
 * each resolved `copy` value (with its label from `copyLabels`), the "To verify" badge on vendor-UI steps,
 * and the form field of the `input` step. `variant="guide"` is the roomier layout of the guide page, so
 * the card and the guide render the same definition. `guideHref` adds the link to the full guide.
 */
export function IntegrationSetupChecklist({ guide, values, inputs, testId, variant = "card", guideHref }: { guide: IntegrationSetupGuide; values: Record<string, string>; inputs?: Record<string, ReactNode>; testId?: string; variant?: "card" | "guide"; guideHref?: string }) {
  const t = useTranslations(guide.namespace);
  const tg = useTranslations("integration_guide");
  const copies = (c: IntegrationSetupGuide["steps"][number]["copy"]) => (c === undefined ? [] : typeof c === "string" ? [c] : [...c]).filter((k) => values[k]);
  return (
    <div className="space-y-2">
      <ol className={cn("space-y-2 text-sm", variant === "guide" && "space-y-3")} data-testid={testId ?? `${guide.provider}-setup`}>
        {guide.steps.map((s, i) => (
          <li key={s.key} className={cn("flex gap-2", variant === "guide" && "rounded-lg border bg-card p-4")} data-testid="setup-step" data-step={s.key}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-hidden>{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1.5 [overflow-wrap:anywhere]">
              {s.titleKey ? (
                <>
                  <p className="font-medium">{t(s.titleKey, values)} {s.verify && <Badge variant="warning" className="ml-1 align-middle">{tg("verify_badge")}</Badge>}</p>
                  <p className="whitespace-pre-line text-xs text-muted-foreground">{t(s.messageKey, values)}</p>
                </>
              ) : (
                <p>{t(s.messageKey, values)} {s.verify && <Badge variant="warning" className="ml-1 align-middle">{tg("verify_badge")}</Badge>}</p>
              )}
              {copies(s.copy).map((k) => (
                <div key={k} className="space-y-1">
                  {guide.copyLabels?.[k] && <p className="text-xs font-medium">{t(guide.copyLabels[k]!)}</p>}
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-testid={`setup-copy-${k}`}>{values[k]}</code>
                    <CopyButton text={values[k]!} label={t("copy")} testId={`setup-copy-button-${k}`} />
                  </div>
                </div>
              ))}
              {s.input && inputs?.[s.input]}
            </div>
          </li>
        ))}
      </ol>
      {guideHref && <p className="text-xs"><Link href={guideHref} className="underline-offset-4 hover:underline">{t("full_guide")}</Link></p>}
    </div>
  );
}

/** A failed connect or test in plain words: what is wrong and the fix (`detail`, e.g. the missing scopes, fills `{detail}`), with the vendor's message underneath. */
export function IntegrationSetupError({ guide, code, values, detail, showDetail = true }: { guide: IntegrationSetupGuide; code: string; values: Record<string, string>; detail?: string | null; showDetail?: boolean }) {
  const t = useTranslations(guide.namespace);
  const e = guide.errors[code] ?? guide.errors.unknown;
  if (!e) return null;
  const v = { ...values, detail: detail ?? "" };
  return (
    <Alert variant="destructive" data-testid="setup-error" data-code={code}>
      <AlertDescription className="space-y-1">
        <p className="font-medium">{t(e.messageKey, v)}</p>
        <p>{t(e.fixKey, v)}</p>
        {showDetail && detail && <p className="text-xs opacity-80 [overflow-wrap:anywhere]">{detail}</p>}
      </AlertDescription>
    </Alert>
  );
}

/** The credential fields of a guide (`fields`), labelled from its namespace; the server validates them again (`validateSetupFields`). */
export function IntegrationSetupFields({ guide, idPrefix }: { guide: IntegrationSetupGuide; idPrefix?: string }) {
  const t = useTranslations(guide.namespace);
  const prefix = idPrefix ?? guide.provider;
  return (
    <>
      {(guide.fields ?? []).map((f) => (
        <div key={f.name} className="space-y-1">
          <Label htmlFor={`${prefix}-${f.name}`}>{t(f.labelKey)}</Label>
          <Input id={`${prefix}-${f.name}`} name={f.name} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" required={!f.optional} minLength={f.minLength} maxLength={f.maxLength} />
        </div>
      ))}
    </>
  );
}

/** Submits through the action without React's automatic form reset, so a failed connect keeps what the merchant typed. */
export const keepValues = (action: (fd: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  startTransition(() => action(fd));
};

/** The verification step's outcome: what the adapter found after a connect or a successful test (`verifiedKey`, filled with the facts). */
export function IntegrationSetupVerified({ guide, facts }: { guide: IntegrationSetupGuide; facts: Record<string, string | number> | null | undefined }) {
  const t = useTranslations(guide.namespace);
  const tc = useTranslations("integration_setup.common");
  return (
    <Alert data-testid="setup-verified" data-provider={guide.provider}>
      <AlertDescription className="[overflow-wrap:anywhere]">{facts && guide.verifiedKey ? t(guide.verifiedKey, facts) : tc("connected")}</AlertDescription>
    </Alert>
  );
}

/** The guide's plain notes (vendor limits, paths not built yet). */
export function IntegrationSetupNotes({ guide }: { guide: IntegrationSetupGuide }) {
  const t = useTranslations(guide.namespace);
  if (!guide.noteKeys?.length) return null;
  return (
    <ul className="space-y-1 text-xs text-muted-foreground" data-testid="setup-notes">
      {guide.noteKeys.map((k) => <li key={k} className="rounded-md border border-dashed p-2">{t(k)}</li>)}
    </ul>
  );
}
