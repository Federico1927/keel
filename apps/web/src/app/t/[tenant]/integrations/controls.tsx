"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, cn } from "@keel/ui";
import { connectGoogle, connectMeta, connectShopifyCustomApp, disconnectIntegration, processWebhookNow, resyncIntegration, retryWebhooks, simulateWebhook, testIntegration } from "@/server/actions/integrations";
import type { ActionResult } from "@/server/action-result";

type Provider = "shopify" | "meta" | "google";

export function ProviderActions({ slug, provider, connected, mock, canManage }: { slug: string; provider: Provider; connected: boolean; mock: boolean; canManage: boolean }) {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  if (!canManage) return null;
  const say = (r: ActionResult<unknown>, okText: string) => {
    if (r.ok) setMsg({ tone: "ok", text: okText });
    else setMsg({ tone: "err", text: (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : tc(`errors.${r.error}`)) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : "") });
    router.refresh();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await testIntegration(slug, provider); say(r, r.ok && r.data ? (r.data.ok ? t("test_ok", { account: r.data.accountName ?? "" }) : t("test_failed", { error: r.data.error ?? "" })) : ""); })}>
          {t("test_connection")}
        </Button>
        {connected && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await resyncIntegration(slug, provider); say(r, r.ok && r.data ? (r.data.queued ? t("resync_queued") : t("resync_done", { summary: r.data.summary })) : ""); })}>
            {t("resync")}
          </Button>
        )}
        {provider === "shopify" && mock && (
          <>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => { const r = await simulateWebhook(slug, "order"); say(r, r.ok && r.data ? t("simulated", { status: r.data.status, order: r.data.orderName ?? "" }) : ""); })}>
              {t("simulate_order")}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => { const r = await simulateWebhook(slug, "cancel"); say(r, r.ok && r.data ? t("simulated", { status: r.data.status, order: r.data.orderName ?? "" }) : ""); })}>
              {t("simulate_cancel")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await simulateWebhook(slug, "bad_signature"); say(r, r.ok && r.data ? t("simulated_rejected", { status: r.data.status }) : ""); })}>
              {t("simulate_bad")}
            </Button>
          </>
        )}
        <Button size="sm" variant={connected && !mock ? "ghost" : "default"} disabled={pending} onClick={() => setShowConnect((v) => !v)}>
          {connected && !mock ? t("reconnect") : t("connect")}
        </Button>
        {connected && !mock && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => say(await disconnectIntegration(slug, provider), t("disconnected")))}>
            {t("disconnect")}
          </Button>
        )}
      </div>
      {msg && (
        <Alert variant={msg.tone === "err" ? "destructive" : "default"}>
          <AlertDescription data-testid={`msg-${provider}`}>{msg.text}</AlertDescription>
        </Alert>
      )}
      {showConnect && <ConnectForm slug={slug} provider={provider} mock={mock} onDone={() => setShowConnect(false)} />}
    </div>
  );
}

function ConnectForm({ slug, provider, mock, onDone }: { slug: string; provider: Provider; mock: boolean; onDone: () => void }) {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const action = provider === "shopify" ? connectShopifyCustomApp : provider === "meta" ? connectMeta : connectGoogle;
  const [state, formAction, pending] = useActionState(action.bind(null, slug), null);
  const fields: { name: string; label: string; type?: string; placeholder?: string }[] = provider === "shopify"
    ? [{ name: "shop", label: t("fields.shop"), placeholder: "my-store.myshopify.com" }, { name: "accessToken", label: t("fields.access_token"), type: "password", placeholder: "shpat_…" }, { name: "apiSecret", label: t("fields.api_secret"), type: "password" }]
    : provider === "meta"
      ? [{ name: "adAccountId", label: t("fields.ad_account"), placeholder: "act_123456789" }, { name: "accessToken", label: t("fields.access_token"), type: "password" }]
      : [{ name: "customerId", label: t("fields.customer_id"), placeholder: "123-456-7890" }, { name: "loginCustomerId", label: t("fields.login_customer_id"), placeholder: "optional" }, { name: "developerToken", label: t("fields.developer_token"), type: "password" }, { name: "clientId", label: t("fields.client_id") }, { name: "clientSecret", label: t("fields.client_secret"), type: "password" }, { name: "refreshToken", label: t("fields.refresh_token"), type: "password" }];
  return (
    <Card className={cn("mt-2", state?.ok && "border-green-600")}>
      <CardHeader>
        <CardTitle className="text-sm">{t(`connect_title.${provider}`)}</CardTitle>
        <CardDescription>{mock ? t("mock_notice") : t(`connect_description.${provider}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <Label htmlFor={`${provider}-${f.name}`}>{f.label}</Label>
              <Input id={`${provider}-${f.name}`} name={f.name} type={f.type ?? "text"} placeholder={f.placeholder} autoComplete="off" required={f.name !== "loginCustomerId"} />
            </div>
          ))}
          {provider === "shopify" && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t("public_app_hint")} <a className="underline" href={`/api/integrations/shopify/oauth/start?tenant=${slug}&shop=`}>{t("public_app_link")}</a>
            </p>
          )}
          {state && !state.ok && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : tc(`errors.${state.error}`)}{state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : ""}</AlertDescription>
            </Alert>
          )}
          {state?.ok && <p className="text-sm text-green-700 sm:col-span-2">{t("connected_ok")}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={pending}>{t("connect")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>{tc("cancel")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function WebhookControls({ slug, failed, canManage }: { slug: string; failed: number; canManage: boolean }) {
  const t = useTranslations("integrations");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!canManage) return null;
  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      <Button size="sm" variant="outline" disabled={pending || failed === 0} onClick={() => start(async () => { const r = await retryWebhooks(slug); setMsg(r.ok && r.data ? t("retried", { n: r.data.processed, total: r.data.retried }) : null); router.refresh(); })}>
        {t("retry_failed", { n: failed })}
      </Button>
    </div>
  );
}

export function WebhookRowAction({ slug, eventId, canManage }: { slug: string; eventId: string; canManage: boolean }) {
  const t = useTranslations("integrations");
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!canManage) return null;
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await processWebhookNow(slug, eventId); router.refresh(); })}>
      {t("replay")}
    </Button>
  );
}
