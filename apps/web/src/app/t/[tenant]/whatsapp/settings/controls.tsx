"use client";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Switch } from "@hullwise/ui";
import type { SpokiSettings } from "@hullwise/addon-spoki";
import type { SpokiTemplate } from "@hullwise/integrations";
import { saveCodRepliesAction, saveSpokiSettingsAction } from "@/server/actions/spoki";
import type { ActionResult } from "@/server/action-result";
import { SPOKI_SETUP } from "@hullwise/config";
import { IntegrationSetupPanel } from "@/components/integration-setup-panel";

export interface TemplateRow {
  key: string;
  label: string;
  /** Variables the row's messages can fill (custom fields map to them). */
  variables: readonly string[];
  /** Order events: the notification switch. */
  notify?: boolean;
}

function Result({ state }: { state: ActionResult | null }) {
  const tc = useTranslations("common");
  const tw = useTranslations("whatsapp.errors");
  if (!state) return null;
  if (state.ok) return <span className="text-sm text-muted-foreground" data-testid="whatsapp-saved">{tc("saved")}</span>;
  return <Alert variant="destructive" className="flex-1"><AlertDescription>{tw.has(state.error) ? tw(state.error) : tc.has(`errors.${state.error}`) ? tc(`errors.${state.error}`) : state.error}{state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : ""}</AlertDescription></Alert>;
}

/** Sender, template language, one Spoki template per event with its custom fields, notifications and opt-out keywords. */
export function SpokiSettingsForm({ slug, settings, templates, rows }: { slug: string; settings: SpokiSettings; templates: SpokiTemplate[]; rows: TemplateRow[] }) {
  const t = useTranslations("whatsapp.settings");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveSpokiSettingsAction.bind(null, slug), null);
  const approved = templates.filter((x) => x.status === "approved");
  const [picked, setPicked] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.key, settings.templates[r.key]?.templateId ?? ""])));
  return (
    <form action={action} data-testid="whatsapp-settings-form">
      <input type="hidden" name="templateKeys" value={rows.map((r) => r.key).join(",")} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("form_title")}</CardTitle>
          <CardDescription>{t("form_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="wa-sender">{t("sender")}</Label>
              <Input id="wa-sender" name="senderNumber" defaultValue={settings.senderNumber ?? ""} placeholder="+15551234567" inputMode="tel" data-testid="wa-sender" />
              <p className="text-xs text-muted-foreground">{t("sender_help")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="wa-lang">{t("language")}</Label>
              <Input id="wa-lang" name="templateLanguage" defaultValue={settings.templateLanguage ?? ""} placeholder="en, it, es_ES" />
              <p className="text-xs text-muted-foreground">{t("language_help")}</p>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("templates_title")}</p>
            <p className="text-xs text-muted-foreground">{approved.length ? t("templates_help", { n: approved.length }) : t("templates_none")}</p>
            {rows.map((r) => {
              const m = settings.templates[r.key];
              const chosen = templates.find((x) => x.id === picked[r.key]);
              return (
                <div key={r.key} className="rounded-md border p-3" data-testid={`template-row-${r.key.replace(":", "-")}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-sm">{r.label}</span>
                    {r.notify !== undefined && (
                      <label className="flex items-center gap-2 text-xs">
                        <Switch name={`notify:${r.key}`} defaultChecked={r.notify} aria-label={t("notify_label", { event: r.label })} data-testid={`notify-${r.key}`} />
                        {t("notify")}
                      </label>
                    )}
                  </div>
                  <div className="mt-2 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`tpl-${r.key}`} className="text-xs">{t("template")}</Label>
                      <Select wrapperClassName="min-w-0" className="truncate" id={`tpl-${r.key}`} name={`tpl:${r.key}`} value={picked[r.key] ?? ""} onChange={(e) => setPicked({ ...picked, [r.key]: e.target.value })} data-testid={`tpl-${r.key}`}>
                        <option value="">{t("free_text")}</option>
                        {approved.map((x) => <option key={x.id} value={x.id}>{x.name}{x.language ? ` (${x.language})` : ""} · #{x.id}</option>)}
                        {picked[r.key] && !approved.some((x) => x.id === picked[r.key]) && <option value={picked[r.key]}>#{picked[r.key]}</option>}
                      </Select>
                      <input type="hidden" name={`name:${r.key}`} value={chosen?.name ?? m?.templateName ?? ""} />
                      {chosen?.body && <p className="text-xs text-muted-foreground" data-testid="template-preview">{chosen.body}</p>}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`fields-${r.key}`} className="text-xs">{t("fields")}</Label>
                      <Input id={`fields-${r.key}`} name={`fields:${r.key}`} defaultValue={Object.entries(m?.fields ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")} placeholder={chosen?.fields.length ? chosen.fields.map((f) => `${f}=${f.toLowerCase()}`).join(", ") : "FIRST_NAME=first_name"} />
                      <p className="text-xs text-muted-foreground">{t("fields_help", { vars: r.variables.join(", ") })}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="space-y-1">
            <Label htmlFor="wa-optout">{t("opt_out")}</Label>
            <Input id="wa-optout" name="optOutKeywords" defaultValue={settings.optOutKeywords.join(", ")} data-testid="wa-optout" />
            <p className="text-xs text-muted-foreground">{t("opt_out_help")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending} data-testid="save-whatsapp">{tc("save")}</Button>
            <Result state={state} />
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/** Reply keywords of COD confirmations (both add-ons on), stored with the COD settings. */
export function CodRepliesForm({ slug, confirm, cancel }: { slug: string; confirm: string[]; cancel: string[] }) {
  const t = useTranslations("whatsapp.settings.cod");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCodRepliesAction.bind(null, slug), null);
  return (
    <form action={action} data-testid="cod-replies-form">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cod-confirm">{t("confirm")}</Label>
              <Input id="cod-confirm" name="confirm" defaultValue={confirm.join(", ")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cod-cancel">{t("cancel")}</Label>
              <Input id="cod-cancel" name="cancel" defaultValue={cancel.join(", ")} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("help")}</p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{tc("save")}</Button>
            <Result state={state} />
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/** Integration card actions: test, resync templates, connect (API key, or the simulated account in mock mode), disconnect. */
/**
 * The setup part of the Spoki sheet (issue #9; self-setup #90): the checklist with the webhook URL to
 * copy and the API key form (any key connects the simulated account in mock mode, demo values answer
 * with each mapped error), open when not connected, behind "Change key or reconnect" when it is.
 */
export function SpokiConnection({ slug, connected, mock, values, triggers, guideHref }: { slug: string; connected: boolean; mock: boolean; values: Record<string, string>; triggers: { value: string; code: string }[]; guideHref: string }) {
  const ti = useTranslations("integrations");
  const [showSetup, setShowSetup] = useState(!connected);
  useEffect(() => {
    if (!connected) setShowSetup(true);
  }, [connected]);
  return (
    <section className="space-y-2">
      {connected && <Button size="sm" variant="outline" onClick={() => setShowSetup((v) => !v)} aria-expanded={showSetup} data-testid="spoki-setup-toggle">{showSetup ? ti("card.hide_setup") : ti("reconnect")}</Button>}
      {showSetup && <IntegrationSetupPanel slug={slug} guide={SPOKI_SETUP} values={values} mock={mock} ownerReady triggers={triggers} guideHref={guideHref} />}
    </section>
  );
}
