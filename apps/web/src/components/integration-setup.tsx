"use client";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { IntegrationSetupGuide } from "@hullwise/config";
import { Alert, AlertDescription, Badge } from "@hullwise/ui";
import { CopyButton } from "@/app/t/[tenant]/cod/queue-extras";

/**
 * A merchant self-setup checklist rendered from plain data (`IntegrationSetupGuide` in @hullwise/config,
 * #86): numbered steps from message keys, a copy button for each resolved `copy` value, the "To verify"
 * badge on vendor-UI steps, and the form field of the `input` step. Kept generic for the shared
 * IntegrationSetup of #89.
 */
export function IntegrationSetupChecklist({ guide, values, inputs, testId }: { guide: IntegrationSetupGuide; values: Record<string, string>; inputs?: Record<string, ReactNode>; testId?: string }) {
  const t = useTranslations(guide.namespace);
  const tg = useTranslations("integration_guide");
  return (
    <ol className="space-y-2 text-sm" data-testid={testId ?? `${guide.provider}-setup`}>
      {guide.steps.map((s, i) => (
        <li key={s.key} className="flex gap-2" data-testid="setup-step" data-step={s.key}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-hidden>{i + 1}</span>
          <div className="min-w-0 flex-1 space-y-1.5 [overflow-wrap:anywhere]">
            <p>{t(s.messageKey, values)} {s.verify && <Badge variant="warning" className="ml-1 align-middle">{tg("verify_badge")}</Badge>}</p>
            {s.copy && values[s.copy] && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-testid={`setup-copy-${s.copy}`}>{values[s.copy]}</code>
                <CopyButton text={values[s.copy]!} label={t("copy")} testId={`setup-copy-button-${s.copy}`} />
              </div>
            )}
            {s.input && inputs?.[s.input]}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A failed connection test in plain words: what is wrong and the fix, with the vendor's message underneath. */
export function IntegrationSetupError({ guide, code, values, detail }: { guide: IntegrationSetupGuide; code: string; values: Record<string, string>; detail?: string | null }) {
  const t = useTranslations(guide.namespace);
  const e = guide.errors[code] ?? guide.errors.unknown;
  if (!e) return null;
  return (
    <Alert variant="destructive" data-testid="setup-error" data-code={code}>
      <AlertDescription className="space-y-1">
        <p className="font-medium">{t(e.messageKey, values)}</p>
        <p>{t(e.fixKey, values)}</p>
        {detail && <p className="text-xs opacity-80 [overflow-wrap:anywhere]">{detail}</p>}
      </AlertDescription>
    </Alert>
  );
}
