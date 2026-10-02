"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Switch } from "@hullwise/ui";
import type { SpokiSettings } from "@hullwise/addon-spoki";
import type { SpokiTemplate } from "@hullwise/integrations";
import { connectSpokiAction, connectSpokiMockAction, disconnectSpokiAction, resyncSpokiAction, saveCodRepliesAction, saveSpokiSettingsAction, testSpokiAction } from "@/server/actions/spoki";
import type { ActionResult } from "@/server/action-result";

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
export function SpokiConnection({ slug, connected, mock, canManage }: { slug: string; connected: boolean; mock: boolean; canManage: boolean }) {
  const t = useTranslations("whatsapp.connection");
  const ti = useTranslations("integrations");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [state, action, saving] = useActionState(connectSpokiAction.bind(null, slug), null);
  if (!canManage) return null;
  const say = (r: ActionResult<unknown>, text: string) => {
    setMsg(r.ok ? { tone: "ok", text } : { tone: "err", text: (ti.has(`errors.${r.error}`) ? ti(`errors.${r.error}`) : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : "") });
    router.refresh();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {connected && (
          <>
            <Button size="sm" variant="outline" disabled={pending} data-testid="spoki-test" onClick={() => start(async () => { const r = await testSpokiAction(slug); say(r, r.ok && r.data ? (r.data.ok ? ti("test_ok", { account: r.data.accountName ?? "" }) : ti("test_failed", { error: r.data.error ?? "" })) : ""); })}>{ti("test_connection")}</Button>
            <Button size="sm" variant="outline" disabled={pending} data-testid="spoki-resync" onClick={() => start(async () => { const r = await resyncSpokiAction(slug); say(r, r.ok && r.data ? t("resynced", { n: r.data.templates, approved: r.data.approved }) : ""); })}>{ti("resync")}</Button>
          </>
        )}
        {mock && !connected && <Button size="sm" disabled={pending} data-testid="spoki-mock-connect" onClick={() => start(async () => say(await connectSpokiMockAction(slug), t("mock_connected")))}>{t("mock_connect")}</Button>}
        <Button size="sm" variant={connected || mock ? "ghost" : "default"} disabled={pending} onClick={() => setShowKey((v) => !v)}>{connected && !mock ? ti("reconnect") : ti("connect")}</Button>
        {connected && <Button size="sm" variant="ghost" disabled={pending} data-testid="spoki-disconnect" onClick={() => start(async () => say(await disconnectSpokiAction(slug), ti("disconnected")))}>{ti("disconnect")}</Button>}
      </div>
      {msg && <Alert variant={msg.tone === "err" ? "destructive" : "default"}><AlertDescription data-testid="msg-spoki">{msg.text}</AlertDescription></Alert>}
      {showKey && (
        <form action={action} className="space-y-2 rounded-md border p-3">
          <p className="text-xs text-muted-foreground">{mock ? ti("mock_notice") : t("key_help")}</p>
          <Label htmlFor="spoki-key">{t("api_key")}</Label>
          <Input id="spoki-key" name="apiKey" type="password" autoComplete="off" required />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={saving}>{ti("connect")}</Button>
            {state?.ok && <Badge variant="success">{ti("connected_ok")}</Badge>}
            {state && !state.ok && <span className="text-sm text-destructive">{ti.has(`errors.${state.error}`) ? ti(`errors.${state.error}`) : tc(`errors.${state.error}`)}{state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : ""}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
