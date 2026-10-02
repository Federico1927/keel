"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { IntegrationSetupGuide } from "@hullwise/config";
import { Alert, AlertDescription, Button, Input, Label } from "@hullwise/ui";
import { IntegrationSetupChecklist, IntegrationSetupError, IntegrationSetupFields } from "@/components/integration-setup";
import { CopyButton } from "../cod/queue-extras";
import { connectShopifyApp, connectShopifyCustomApp } from "@/server/actions/shopify";

/** Errors after which "Install on your store" (authorization code grant with the saved app) is the way forward. */
const INSTALL_ERRORS = new Set(["not_in_organization", "not_installed"]);

/**
 * Shopify on the integrations card (issue #89): the merchant's checklist with copy buttons, the Connect
 * form (shop domain, Client ID, Client secret → client credentials grant), the "Install on your store"
 * fallback with the redirect URL to add to the app version, plain-language errors, and the advanced paths
 * (platform public app, legacy pasted token).
 */
export function ShopifySetup({ slug, definition, values, guideHref, connected, mock, canManage, publicApp, savedApp, flashError, missing }: { slug: string; definition: IntegrationSetupGuide; values: Record<string, string>; guideHref: string; connected: boolean; mock: boolean; canManage: boolean; publicApp: boolean; savedApp: { shop: string; clientId: string } | null; flashError: string | null; missing: { required: string[]; optional: string[] } }) {
  const t = useTranslations("integration_setup.shopify");
  const tc = useTranslations("integration_setup.common");
  const [open, setOpen] = useState(!connected);
  const [state, formAction, pending] = useActionState(connectShopifyApp.bind(null, slug), null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const error = state && !state.ok ? state.error : flashError;
  const detail = state && !state.ok ? (state.fieldErrors?.scopes ?? state.fieldErrors?.platform ?? null) : null;
  const installHref = `/api/integrations/shopify/oauth/start?tenant=${slug}&app=tenant`;
  return (
    <div className="space-y-3" data-testid="shopify-setup-block">
      {missing.required.length > 0 && <div data-testid="shopify-missing-required"><IntegrationSetupError guide={definition} code="missing_scopes" values={values} detail={missing.required.join(", ")} showDetail={false} /></div>}
      {missing.required.length === 0 && missing.optional.length > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs" data-testid="shopify-missing-optional">{t("missing_optional", { scopes: missing.optional.join(", ") })}</p>
      )}
      {!canManage ? null : (
        <>
          {connected && <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} data-testid="shopify-setup-toggle">{open ? tc("hide_setup") : t("reconnect")}</Button>}
          {open && (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">{mock ? t("mock_notice") : t("intro")}</p>
              <IntegrationSetupChecklist guide={definition} values={values} guideHref={guideHref} />
              <form action={formAction} className="grid gap-3 sm:grid-cols-2" data-testid="shopify-connect-form">
                <IntegrationSetupFields guide={definition} idPrefix="shopify" />
                <div className="flex items-end sm:col-span-2">
                  <Button type="submit" size="sm" disabled={pending} data-testid="shopify-connect">{pending ? tc("connecting") : t("connect")}</Button>
                </div>
              </form>
              {savedApp && !state?.ok && <p className="text-xs text-muted-foreground" data-testid="shopify-saved-app">{t("saved_app", { shop: savedApp.shop, clientId: savedApp.clientId })}</p>}
              {state?.ok && state.data && (
                <Alert data-testid="shopify-connected"><AlertDescription>{t(state.data.history === "already_done" ? "connected_no_import" : "connected", { shop: state.data.shop })}{state.data.missingOptional.length > 0 ? ` ${t("missing_optional", { scopes: state.data.missingOptional.join(", ") })}` : ""}</AlertDescription></Alert>
              )}
              {error && <IntegrationSetupError guide={definition} code={error} values={values} detail={detail} showDetail={error !== "missing_scopes"} />}
              {(error && INSTALL_ERRORS.has(error)) || savedApp ? (
                <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="shopify-install">
                  <p className="text-xs">{t("install_hint")}</p>
                  {values.redirect_url && (
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-testid="install-redirect-url">{values.redirect_url}</code>
                      <CopyButton text={values.redirect_url} label={t("copy")} testId="install-redirect-url-copy" />
                    </div>
                  )}
                  <Button size="sm" variant={error && INSTALL_ERRORS.has(error) ? "default" : "outline"} asChild={!mock} disabled={mock}>
                    {mock ? <span>{t("install")}</span> : <a href={installHref} data-testid="shopify-install-link">{t("install")}</a>}
                  </Button>
                </div>
              ) : null}
              <details className="rounded-md border p-3 text-sm" data-testid="shopify-advanced">
                <summary className="cursor-pointer text-xs font-medium">{t("advanced")}</summary>
                <div className="mt-3 space-y-4">
                  {publicApp && (
                    <form method="get" action="/api/integrations/shopify/oauth/start" className="space-y-2">
                      <p className="text-xs text-muted-foreground">{t("public_app_hint")}</p>
                      <input type="hidden" name="tenant" value={slug} />
                      <input type="hidden" name="app" value="public" />
                      <div className="flex flex-col gap-2 sm:flex-row"><Input name="shop" placeholder="my-store.myshopify.com" required aria-label={t("fields.shop")} /><Button type="submit" size="sm" variant="outline">{t("public_app_link")}</Button></div>
                    </form>
                  )}
                  <LegacyTokenForm slug={slug} />
                </div>
              </details>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Advanced: an existing custom app created in the Shopify admin before 2026 (pasted token + API secret). */
function LegacyTokenForm({ slug }: { slug: string }) {
  const t = useTranslations("integration_setup.shopify");
  const ti = useTranslations("integrations");
  const tc = useTranslations("common");
  const [state, formAction, pending] = useActionState(connectShopifyCustomApp.bind(null, slug), null);
  return (
    <form action={formAction} className="space-y-2" data-testid="shopify-legacy-form">
      <p className="text-xs font-medium">{t("legacy_title")}</p>
      <p className="text-xs text-muted-foreground">{t("legacy_hint")}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor="legacy-shop">{t("fields.shop")}</Label><Input id="legacy-shop" name="shop" placeholder="my-store.myshopify.com" required autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor="legacy-token">{ti("fields.access_token")}</Label><Input id="legacy-token" name="accessToken" type="password" placeholder="shpat_…" required autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor="legacy-secret">{ti("fields.api_secret")}</Label><Input id="legacy-secret" name="apiSecret" type="password" required autoComplete="off" /></div>
      </div>
      {state && !state.ok && <p className="text-xs text-destructive">{ti.has(`errors.${state.error}`) ? ti(`errors.${state.error}`) : t.has(`errors.${state.error}.message`) ? t(`errors.${state.error}.message`, { detail: "" }) : tc(`errors.${state.error}`)}</p>}
      {state?.ok && <p className="text-xs text-success">{ti("connected_ok")}</p>}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{t("legacy_connect")}</Button>
    </form>
  );
}
