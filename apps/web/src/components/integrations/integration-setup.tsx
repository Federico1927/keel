"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";
import type { IntegrationSetupDefinition, SetupField } from "@hullwise/config";
import { Alert, AlertDescription, Badge, Button, Input, Label, cn } from "@hullwise/ui";

/**
 * Self-serve setup of an integration, driven by its definition (`packages/config/src/integration-setup.ts`)
 * and the messages under `integration_setup.<provider>`. Shared by the integrations card (compact) and the
 * guide page (full), so the two never disagree. Copyable values arrive resolved from the server
 * (`resolveSetupValues`, apps/web/src/server/integration-setup.ts).
 */

/** A value with a copy button (scope list, redirect URL…): monospace, wraps on phones. */
export function CopyValue({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const t = useTranslations("integration_setup.common");
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1" data-testid={testId ? `${testId}-block` : undefined}>
      <div className="text-xs font-medium">{label}</div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-relaxed" data-testid={testId}>{value}</code>
        <Button type="button" size="sm" variant="outline" className="shrink-0" aria-label={`${t("copy")}: ${label}`} data-testid={testId ? `${testId}-copy` : undefined} onClick={() => { void navigator.clipboard?.writeText(value).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
          {copied ? <Check /> : <Copy />} <span className="max-sm:sr-only">{copied ? t("copied") : t("copy")}</span>
        </Button>
      </div>
    </div>
  );
}

/** The numbered checklist: one item per step, the "Da verificare" badge, the step's copyable values. */
export function IntegrationSetupSteps({ definition, values, variant = "card", guideHref }: { definition: IntegrationSetupDefinition; values: Record<string, string>; variant?: "card" | "guide"; guideHref?: string }) {
  const t = useTranslations(`integration_setup.${definition.provider}`);
  const tc = useTranslations("integration_setup.common");
  return (
    <div className="space-y-2" data-testid={`setup-${definition.provider}`}>
      <ol className={cn("space-y-2", variant === "guide" && "space-y-3")}>
        {definition.steps.map((s, i) => (
          <li key={s.id} className={cn("rounded-md border p-3", variant === "guide" && "bg-card p-4")} data-testid="setup-step" data-step={s.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{i + 1}</span>
              <span className="text-sm font-medium">{t(`steps.${s.id}.title`)}</span>
              {s.verify && <Badge variant="warning">{tc("verify_badge")}</Badge>}
            </div>
            <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{t(`steps.${s.id}.body`)}</p>
            {s.copy && s.copy.filter((c) => values[c]).length > 0 && (
              <div className="mt-2 space-y-2">
                {s.copy.filter((c) => values[c]).map((c) => <CopyValue key={c} label={t(`values.${c}`)} value={values[c]!} testId={`copy-${c}`} />)}
              </div>
            )}
          </li>
        ))}
      </ol>
      {guideHref && <p className="text-xs"><Link href={guideHref} className="underline-offset-4 hover:underline">{tc("full_guide")}</Link></p>}
    </div>
  );
}

/** An error code of the definition in plain words: what happened and the fix (`detail`: the vendor's own message or the missing scopes). */
export function SetupErrorMessage({ provider, code, detail, testId }: { provider: string; code: string; detail?: string | null; testId?: string }) {
  const t = useTranslations(`integration_setup.${provider}`);
  const tc = useTranslations("integration_setup.common");
  const known = t.has(`errors.${code}.message`);
  return (
    <Alert variant="destructive" data-testid={testId ?? `setup-error-${provider}`} data-code={code}>
      <AlertDescription className="space-y-1">
        <span className="block font-medium">{known ? t(`errors.${code}.message`, { detail: detail ?? "" }) : tc("unknown_error")}</span>
        {known && <span className="block text-xs">{t(`errors.${code}.fix`, { detail: detail ?? "" })}</span>}
        {detail && !known && <span className="block break-all font-mono text-xs">{detail}</span>}
      </AlertDescription>
    </Alert>
  );
}

/** The credential fields of a definition (labels from `integration_setup.<provider>.fields`). */
export function SetupFields({ definition, idPrefix }: { definition: IntegrationSetupDefinition; idPrefix: string }) {
  const t = useTranslations(`integration_setup.${definition.provider}`);
  return (
    <>
      {definition.fields.map((f: SetupField) => (
        <div key={f.name} className="space-y-1">
          <Label htmlFor={`${idPrefix}-${f.name}`}>{t(`fields.${f.name}`)}</Label>
          <Input id={`${idPrefix}-${f.name}`} name={f.name} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" required minLength={f.minLength} maxLength={f.maxLength} />
        </div>
      ))}
    </>
  );
}
