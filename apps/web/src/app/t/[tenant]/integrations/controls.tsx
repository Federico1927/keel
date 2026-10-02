"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { IntegrationSetupGuide } from "@hullwise/config";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, cn } from "@hullwise/ui";
import { connectGoogle, connectTiktok, processWebhookNow, retryWebhooks } from "@/server/actions/integrations";
import { connectTiktokDemo } from "@/server/actions/integration-card";
import { IntegrationSetupPanel } from "@/components/integration-setup-panel";
import { useIntegrationCard } from "@/components/integration-card";

type Provider = "shopify" | "meta" | "google" | "tiktok" | "anthropic" | "address";
type AdvancedProvider = "google" | "tiktok";

/** The self-setup block of a card (#90): the guide and what the server resolved for it. */
export interface ProviderSetup {
  guide: IntegrationSetupGuide;
  values: Record<string, string>;
  ownerReady: boolean;
  triggers: { value: string; code: string }[];
  flashError: string | null;
  guideHref: string;
  /** Google: the accounts of a sign-in waiting for the pick. */
  accounts?: { customerId: string; name: string; loginCustomerId: string | null; managerName: string | null }[] | null;
}

/**
 * The setup part of a provider's sheet (#90): the self-setup panel of its guide, open when the card is
 * not connected (or after a sign-in, or with an error back from an OAuth redirect), behind "Change
 * account or reconnect" when it is. TikTok's simulated account and Google's account picker live here.
 */
export function ProviderSetupSection({ provider, connected, mock, setup }: { provider: Provider; connected: boolean; mock: boolean; setup: ProviderSetup }) {
  const t = useTranslations("integrations");
  const card = useIntegrationCard();
  const [open, setOpen] = useState(!connected || !!setup.flashError || !!setup.accounts?.length);
  // an error back from a redirect stays until this sheet connects the provider
  const [connectedAtOpen] = useState(connected);
  useEffect(() => {
    if (!connected || setup.accounts?.length) setOpen(true);
  }, [connected, setup.accounts?.length]);
  const startUrl = `/api/integrations/${provider}/oauth/start?tenant=${card.slug}`;
  const oauth = provider === "google" || provider === "tiktok";
  return (
    <section className="space-y-2">
      {connected && <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={`${provider}-setup-toggle`}>{open ? t("card.hide_setup") : t("reconnect")}</Button>}
      {open && (
        <IntegrationSetupPanel
          slug={card.slug}
          guide={setup.guide}
          values={setup.values}
          mock={mock}
          ownerReady={setup.ownerReady}
          triggers={setup.triggers}
          flashError={connected && !connectedAtOpen ? null : setup.flashError}
          guideHref={setup.guideHref}
          accounts={setup.accounts}
          oauthHref={oauth ? startUrl : null}
          onMockOAuth={provider === "tiktok" && mock ? () => card.start(async () => card.show(await connectTiktokDemo(card.slug))) : undefined}
          oauthPending={card.pending}
          denyHref={oauth ? `${startUrl}&simulate=access_denied` : null}
          advanced={provider === "google" || provider === "tiktok" ? <ConnectForm slug={card.slug} provider={provider} mock={mock} /> : undefined}
        />
      )}
    </section>
  );
}

/** Advanced: the store's own credentials (Google Ads developer token and OAuth client; its own TikTok app). */
function ConnectForm({ slug, provider, mock }: { slug: string; provider: AdvancedProvider; mock: boolean }) {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const action = provider === "tiktok" ? connectTiktok : connectGoogle;
  const [state, formAction, pending] = useActionState(action.bind(null, slug), null);
  const fields: { name: string; label: string; type?: string; placeholder?: string }[] = provider === "tiktok"
    ? [{ name: "appId", label: t("fields.app_id") }, { name: "appSecret", label: t("fields.app_secret"), type: "password" }, { name: "authCode", label: t("fields.auth_code"), type: "password" }]
    : [{ name: "customerId", label: t("fields.customer_id"), placeholder: "123-456-7890" }, { name: "loginCustomerId", label: t("fields.login_customer_id"), placeholder: "optional" }, { name: "developerToken", label: t("fields.developer_token"), type: "password" }, { name: "clientId", label: t("fields.client_id") }, { name: "clientSecret", label: t("fields.client_secret"), type: "password" }, { name: "refreshToken", label: t("fields.refresh_token"), type: "password" }];
  return (
    <Card className={cn(state?.ok && "border-success")}>
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
          {state && !state.ok && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : tc(`errors.${state.error}`)}{state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : ""}</AlertDescription>
            </Alert>
          )}
          {state?.ok && <p className="text-sm text-success sm:col-span-2">{t("connected_ok")}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={pending}>{t("connect")}</Button>
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
