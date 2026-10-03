"use client";
// i18n-client-namespaces: integration_setup, integrations, common (guide.namespace is integration_setup.<provider>)
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { IntegrationSetupGuide } from "@hullwise/config";
import { Button, Label, Select } from "@hullwise/ui";
import { IntegrationSetupChecklist, IntegrationSetupError, IntegrationSetupFields, IntegrationSetupNotes, IntegrationSetupVerified, keepValues } from "@/components/integration-setup";
import { connectSetup, pickGoogleAdsAccount, type SetupConnected } from "@/server/actions/integration-setup";
import type { ActionResult } from "@/server/action-result";

/** A failed action carrying the guide's plain-words error (`fail("setup", { setup, platform })`). */
export const setupErrorOf = (r: ActionResult<unknown> | null | undefined) => (r && !r.ok && r.error === "setup" ? { code: r.fieldErrors?.setup ?? "unknown", detail: r.fieldErrors?.platform || null } : null);

export interface SetupPanelProps {
  slug: string;
  guide: IntegrationSetupGuide;
  values: Record<string, string>;
  mock: boolean;
  /** The platform's own app for this path is configured (always true in mock mode). */
  ownerReady: boolean;
  /** Mock mode: the demo values that make the simulator answer with each mapped error. */
  triggers?: { value: string; code: string }[];
  /** An error that came back in the URL (OAuth callbacks: `setup_error`). */
  flashError?: string | null;
  guideHref?: string;
  /** `oauth_code`: the sign-in link (the simulator's route in mock mode, unless `onMockOAuth` connects in place). */
  oauthHref?: string | null;
  onMockOAuth?: () => void;
  oauthPending?: boolean;
  /** Mock mode: a link that answers like the vendor does when the merchant refuses the consent. */
  denyHref?: string | null;
  /** Google: the accounts the sign-in returned, to pick one. */
  accounts?: { customerId: string; name: string; loginCustomerId: string | null; managerName: string | null }[] | null;
  /** The manual path (the store's own app or credentials). */
  advanced?: ReactNode;
}

/**
 * The self-setup block of an integration card (#90), rendered from its `IntegrationSetupGuide`: intro,
 * numbered checklist with copy buttons and "To verify" badges, notes, then the connect strategy — the
 * credential form (values kept on failure), the sign-in button (`oauth_code`, disabled with the owner
 * prerequisite explained when the platform's app is missing), or a plain Connect (`platform_connection`)
 * — the plain-words error with its fix, and the verification line with what the adapter found.
 */
export function IntegrationSetupPanel({ slug, guide, values, mock, ownerReady, triggers, flashError, guideHref, oauthHref, onMockOAuth, oauthPending, denyHref, accounts, advanced }: SetupPanelProps) {
  const t = useTranslations(guide.namespace);
  const tc = useTranslations("integration_setup.common");
  const ti = useTranslations("integrations");
  const tcm = useTranslations("common");
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(connectSetup.bind(null, slug, guide.provider), null);
  // the Google account pick answers here too, so its outcome stays once the picker is gone
  const [picked, setPicked] = useState<ActionResult<SetupConnected> | null>(null);
  useEffect(() => {
    if (formState?.ok) router.refresh();
  }, [formState, router]);
  const state = picked ?? formState;
  const setup = setupErrorOf(state);
  const other = state && !state.ok && !setup ? (ti.has(`errors.${state.error}`) ? ti(`errors.${state.error}`) : tcm.has(`errors.${state.error}`) ? tcm(`errors.${state.error}`) : state.error) : null;
  const oauth = guide.strategy === "oauth_code";
  const ownerMissing = !mock && !ownerReady;
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid={`${guide.provider}-setup-panel`}>
      <p className="text-xs text-muted-foreground">{mock ? tc("mock_notice") : t("intro")}</p>
      <IntegrationSetupChecklist guide={guide} values={values} guideHref={guideHref} />
      <IntegrationSetupNotes guide={guide} />
      {ownerMissing && guide.errors.app_not_configured && <div data-testid="setup-owner-missing"><IntegrationSetupError guide={guide} code="app_not_configured" values={values} /></div>}
      {oauth ? (
        <div className="flex flex-wrap items-center gap-2">
          {onMockOAuth && mock ? (
            <Button size="sm" disabled={oauthPending} onClick={onMockOAuth} data-testid={`${guide.provider}-mock-connect`}>{t(guide.oauthLabelKey ?? "connect")}</Button>
          ) : (
            <Button size="sm" asChild={!ownerMissing && !!oauthHref} disabled={ownerMissing || !oauthHref}>
              {!ownerMissing && oauthHref ? <a href={oauthHref} data-testid={`${guide.provider}-oauth`}>{t(guide.oauthLabelKey ?? "connect")}</a> : <span>{t(guide.oauthLabelKey ?? "connect")}</span>}
            </Button>
          )}
          {mock && denyHref && <a href={denyHref} className="text-xs underline-offset-4 hover:underline" data-testid={`${guide.provider}-mock-deny`}>{tc("mock_deny")}</a>}
        </div>
      ) : (
        <form onSubmit={keepValues(formAction)} className="grid gap-3 sm:grid-cols-2" data-testid={`${guide.provider}-connect-form`}>
          <IntegrationSetupFields guide={guide} idPrefix={`setup-${guide.provider}`} />
          <div className="flex items-end sm:col-span-2">
            <Button type="submit" size="sm" disabled={pending} data-testid={`${guide.provider}-connect`}>{pending ? tc("connecting") : t("connect")}</Button>
          </div>
        </form>
      )}
      {mock && triggers && triggers.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="setup-mock-triggers">
          {tc("mock_triggers")} {triggers.map((x) => <code key={x.value} className="rounded bg-muted px-1" title={x.code}>{x.value}</code>)}
        </p>
      )}
      {accounts && accounts.length > 0 && <GoogleAccountPicker slug={slug} guide={guide} accounts={accounts} onResult={setPicked} />}
      {flashError && !state && <IntegrationSetupError guide={guide} code={flashError} values={values} />}
      {setup && <IntegrationSetupError guide={guide} code={setup.code} values={values} detail={setup.detail} />}
      {other && <p className="text-xs text-destructive">{other}</p>}
      {state?.ok && <IntegrationSetupVerified guide={guide} facts={state.data?.verification} />}
      {advanced && (
        <details className="rounded-md border p-3 text-sm" data-testid={`${guide.provider}-advanced`}>
          <summary className="cursor-pointer text-xs font-medium">{t(guide.advancedKey ?? "advanced")}</summary>
          <div className="mt-3">{advanced}</div>
        </details>
      )}
    </div>
  );
}

/** Google Ads after the sign-in: the accounts the user can reach, grouped by the manager they are read through. */
function GoogleAccountPicker({ slug, guide, accounts, onResult }: { slug: string; guide: IntegrationSetupGuide; accounts: NonNullable<SetupPanelProps["accounts"]>; onResult: (r: ActionResult<SetupConnected>) => void }) {
  const t = useTranslations(guide.namespace);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState(accounts[0]!.customerId);
  const label = (a: (typeof accounts)[number]) => `${a.name} · ${a.customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}`;
  const groups = [...new Set(accounts.map((a) => a.managerName ?? ""))];
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="google-account-picker">
      <Label htmlFor="google-account">{t("pick_label")}</Label>
      <Select id="google-account" size="sm" value={choice} onChange={(e) => setChoice(e.target.value)}>
        {groups.map((g) => g ? (
          <optgroup key={g} label={t("pick_manager", { manager: g })}>{accounts.filter((a) => a.managerName === g).map((a) => <option key={a.customerId} value={a.customerId}>{label(a)}</option>)}</optgroup>
        ) : accounts.filter((a) => !a.managerName).map((a) => <option key={a.customerId} value={a.customerId}>{label(a)}</option>))}
      </Select>
      <Button size="sm" disabled={pending} data-testid="google-account-pick" onClick={() => start(async () => { const r = await pickGoogleAdsAccount(slug, choice); onResult(r); if (r.ok) router.refresh(); })}>{t("pick_button")}</Button>
    </div>
  );
}
