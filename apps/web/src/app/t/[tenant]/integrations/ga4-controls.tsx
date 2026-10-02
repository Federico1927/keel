"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { GA4_SETUP } from "@hullwise/config";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Textarea, cn } from "@hullwise/ui";
import { connectGa4, connectGa4Mock, connectGa4Property, disconnectGa4, listGa4Properties, resyncGa4, setGa4Property, testGa4 } from "@/server/actions/ga4";
import type { ActionResult } from "@/server/action-result";
import { IntegrationSetupChecklist, IntegrationSetupError } from "@/components/integration-setup";

type Msg = { tone: "ok" | "err"; text: string } | null;

/** A failed action that carries a plain-words setup error (`fail("ga4_setup", { setup })`). */
const setupOf = (r: ActionResult<unknown> | null) => (r && !r.ok && r.error === "ga4_setup" ? { code: r.fieldErrors?.setup ?? "unknown", detail: r.fieldErrors?.platform ?? null } : null);

/**
 * Actions of the GA4 card (#86). Not connected: the self-setup checklist (add the platform's reader
 * e-mail as Viewer, paste the property id, connect), the simulated property in mock mode, and the
 * advanced path with the store's own service account or OAuth. Connected: test, resync, property picker, disconnect.
 */
export function Ga4Controls({ slug, connected, mock, canManage, propertyId, email, demoPropertyId }: { slug: string; connected: boolean; mock: boolean; canManage: boolean; propertyId: string | null; email: string | null; demoPropertyId: string | null }) {
  const t = useTranslations("ga4.card");
  const ts = useTranslations("ga4.setup");
  const ti = useTranslations("integrations");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [setupError, setSetupError] = useState<{ code: string; detail: string | null } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [properties, setProperties] = useState<{ propertyId: string; displayName: string; accountName: string | null }[] | null>(null);
  const [typed, setTyped] = useState("");
  const [connectState, connectAction, connecting] = useActionState(connectGa4Property.bind(null, slug), null);
  if (!canManage) return null;
  const values = { email: email ?? "", serviceAccountEmail: email ?? "" };
  const error = (r: ActionResult<unknown>) => (r.ok ? "" : (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : ti.has(`errors.${r.error}`) ? ti(`errors.${r.error}`) : tc(`errors.${r.error}`)) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : ""));
  const say = (r: ActionResult<unknown>, okText: string) => {
    const setup = setupOf(r);
    setSetupError(setup);
    setMsg(r.ok ? { tone: "ok", text: okText } : setup ? null : { tone: "err", text: error(r) });
    router.refresh();
  };
  const choose = (id: string) => start(async () => { const r = await setGa4Property(slug, id); say(r, r.ok ? t("property_saved", { name: r.data?.name ?? id }) : ""); if (r.ok) setProperties(null); });
  const connectSetup = setupOf(connectState);
  return (
    <div className="space-y-3" data-testid="ga4-controls">
      {!connected && (
        <div className="space-y-3 rounded-md border p-3" data-testid="ga4-setup-panel">
          <div>
            <p className="font-medium">{ts("title")}</p>
            <p className="text-xs text-muted-foreground">{ts("intro")}</p>
          </div>
          {email ? (
            <form action={connectAction} className="space-y-3">
              <IntegrationSetupChecklist
                guide={GA4_SETUP}
                values={values}
                inputs={{
                  propertyId: (
                    <div className="space-y-1">
                      <Label htmlFor="ga4-setup-property" className="sr-only">{t("property_id")}</Label>
                      <Input id="ga4-setup-property" name="propertyId" size="sm" placeholder={demoPropertyId ?? "123456789"} inputMode="numeric" autoComplete="off" required data-testid="ga4-setup-property" />
                      {demoPropertyId && <p className="text-xs text-muted-foreground">{ts("demo_hint", { id: demoPropertyId })}</p>}
                    </div>
                  ),
                }}
              />
              {connectSetup && <IntegrationSetupError guide={GA4_SETUP} code={connectSetup.code} values={values} detail={connectSetup.detail} />}
              {connectState && !connectState.ok && !connectSetup && <p className="text-xs text-destructive">{error(connectState)}</p>}
              {connectState?.ok && <p className="text-sm text-success">{ti("connected_ok")}</p>}
              <Button type="submit" size="sm" disabled={connecting} data-testid="ga4-setup-connect">{ts("connect")}</Button>
            </form>
          ) : <p className="text-xs text-warning" data-testid="ga4-not-configured">{ts("not_configured")}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!connected && mock && <Button size="sm" variant="outline" disabled={pending} data-testid="ga4-connect-mock" onClick={() => start(async () => { const r = await connectGa4Mock(slug); say(r, r.ok ? t(r.data?.finished ? "backfill_done" : "backfill_running", { n: r.data?.rows ?? 0 }) : ""); })}>{t("connect_mock")}</Button>}
        {connected && (
          <>
            <Button size="sm" variant="outline" disabled={pending} data-testid="ga4-test" onClick={() => start(async () => { const r = await testGa4(slug); setSetupError(r.ok && r.data && !r.data.ok ? { code: r.data.setup ?? "unknown", detail: r.data.error ?? null } : null); setMsg(r.ok && r.data?.ok ? { tone: "ok", text: ti("test_ok", { account: r.data.accountName ?? "" }) } : r.ok ? null : { tone: "err", text: error(r) }); router.refresh(); })}>{ti("test_connection")}</Button>
            <Button size="sm" variant="outline" disabled={pending} data-testid="ga4-resync" onClick={() => start(async () => { const r = await resyncGa4(slug); say(r, r.ok ? (r.data?.queued ? t("resync_queued") : t(r.data?.finished ? "resync_done" : "backfill_running", { n: r.data?.rows ?? 0 })) : ""); })}>{ti("resync")}</Button>
            <Button size="sm" variant="outline" disabled={pending} data-testid="ga4-properties" onClick={() => start(async () => { const r = await listGa4Properties(slug); if (r.ok) setProperties(r.data ?? []); else say(r, ""); })}>{t("choose_property")}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (window.confirm(t("disconnect_confirm"))) start(async () => say(await disconnectGa4(slug), t("disconnected"))); }}>{ti("disconnect")}</Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced} data-testid="ga4-advanced">{ts("advanced")}</Button>
      </div>
      {properties && (
        <div className="space-y-2 rounded-md border p-3" data-testid="ga4-property-picker">
          {properties.length > 0 ? (
            <div className="space-y-1">
              <Label htmlFor="ga4-property-select">{t("property")}</Label>
              <Select id="ga4-property-select" size="sm" defaultValue={propertyId ?? ""} disabled={pending} onChange={(e) => e.target.value && e.target.value !== propertyId && choose(e.target.value)}>
                {properties.map((p) => <option key={p.propertyId} value={p.propertyId}>{p.displayName} · {p.propertyId}{p.accountName ? ` (${p.accountName})` : ""}</option>)}
              </Select>
            </div>
          ) : <p className="text-xs text-muted-foreground">{t("properties_empty")}</p>}
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) choose(typed.trim()); }}>
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="ga4-property-id">{t("property_id")}</Label>
              <Input id="ga4-property-id" size="sm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="123456789" inputMode="numeric" autoComplete="off" />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={pending || !typed.trim()}>{t("set_property")}</Button>
          </form>
        </div>
      )}
      {setupError && <IntegrationSetupError guide={GA4_SETUP} code={setupError.code} values={values} detail={setupError.detail} />}
      {showAdvanced && <Ga4ConnectForm slug={slug} mock={mock} onDone={() => setShowAdvanced(false)} />}
      {msg && <p className={cn("text-xs", msg.tone === "ok" ? "text-success" : "text-destructive")} role="status" data-testid="ga4-msg">{msg.text}</p>}
    </div>
  );
}

function Ga4ConnectForm({ slug, mock, onDone }: { slug: string; mock: boolean; onDone: () => void }) {
  const t = useTranslations("ga4.card");
  const ti = useTranslations("integrations");
  const tc = useTranslations("common");
  const [auth, setAuth] = useState<"service_account" | "oauth">("service_account");
  const [state, formAction, pending] = useActionState(connectGa4.bind(null, slug), null);
  const err = state && !state.ok ? (t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : ti.has(`errors.${state.error}`) ? ti(`errors.${state.error}`) : tc(`errors.${state.error}`)) + (state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : "") : null;
  return (
    <Card className={cn("mt-2", state?.ok && "border-success")}>
      <CardHeader>
        <CardTitle className="text-sm">{t("connect_title")}</CardTitle>
        <CardDescription>{mock ? ti("mock_notice") : t("connect_description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-3">
          <input type="hidden" name="auth" value={auth} />
          <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" role="tablist">
            {(["service_account", "oauth"] as const).map((a) => <button key={a} type="button" role="tab" aria-selected={auth === a} onClick={() => setAuth(a)} className={cn("flex-1 rounded-sm px-2 py-1", auth === a ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`auth.${a}`)}</button>)}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ga4-propertyId">{t("property_id")}</Label>
            <Input id="ga4-propertyId" name="propertyId" placeholder="123456789" inputMode="numeric" autoComplete="off" required />
            <p className="text-xs text-muted-foreground">{t("property_id_help")}</p>
          </div>
          {auth === "service_account" ? (
            <div className="space-y-1">
              <Label htmlFor="ga4-serviceAccountJson">{t("service_account_json")}</Label>
              <Textarea id="ga4-serviceAccountJson" name="serviceAccountJson" rows={5} className="font-mono text-xs" placeholder='{ "type": "service_account", … }' autoComplete="off" required />
              <p className="text-xs text-muted-foreground">{t("service_account_help")}</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="ga4-clientId">{ti("fields.client_id")}</Label><Input id="ga4-clientId" name="clientId" autoComplete="off" required /></div>
              <div className="space-y-1"><Label htmlFor="ga4-clientSecret">{ti("fields.client_secret")}</Label><Input id="ga4-clientSecret" name="clientSecret" type="password" autoComplete="off" required /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="ga4-refreshToken">{ti("fields.refresh_token")}</Label><Input id="ga4-refreshToken" name="refreshToken" type="password" autoComplete="off" required /></div>
            </div>
          )}
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
          {state?.ok && <p className="text-sm text-success">{ti("connected_ok")}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>{ti("connect")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>{tc("cancel")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
