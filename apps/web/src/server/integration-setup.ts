import { SUBSCRIPTION_SETUPS, apiEndpoint, appUrl, ownerSetupReady, setupCopyValues, type IntegrationSetupGuide } from "@hullwise/config";
import { ADS_UTM_TEMPLATES } from "@hullwise/core";
import { GOOGLE_ADDRESS_APIS, GOOGLE_ADS_SCOPE, META_REQUIRED_PERMISSIONS, MOCK_SETUP_TRIGGERS, SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES, SUBSCRIPTION_SCOPES, SUBSCRIPTION_WEBHOOK_TOPICS, TIKTOK_SCOPES_BY_MODULE, ga4ServiceAccountEmail, integrationMode } from "@hullwise/integrations";
import { spokiWebhookUrl } from "@/server/spoki-webhook";

/** What a resolver may need: the tenant (per-tenant webhook URLs) and whether the viewer may see its secret token. */
export interface SetupValueContext {
  tenantId?: string | null;
  canSeeSecrets?: boolean;
}

/**
 * Copyable values of the setup definitions, resolved on the server (scope lists live in the adapters,
 * URLs depend on the deployment's hosts and, for webhooks, on the tenant). A new provider adds its ids here.
 */
const RESOLVERS: Record<string, (c: SetupValueContext) => string | null> = {
  "shopify.scopes_required": () => SHOPIFY_REQUIRED_SCOPES.join(","),
  "shopify.scopes_optional": () => SHOPIFY_OPTIONAL_SCOPES.join(","),
  "shopify.redirect_url": () => apiEndpoint("/integrations/shopify/oauth/callback"),
  "shopify.app_url": () => appUrl(),
  "shopify.webhook_url": () => apiEndpoint("/webhooks/shopify"),
  "shopify.compliance_url": () => apiEndpoint("/webhooks/shopify/compliance"),
  "ga4.serviceAccountEmail": () => ga4ServiceAccountEmail(),
  "meta.permissions": () => META_REQUIRED_PERMISSIONS.join(", "),
  "meta.utm_template": () => ADS_UTM_TEMPLATES.meta,
  "google.scope": () => GOOGLE_ADS_SCOPE,
  "google.redirect_url": () => apiEndpoint("/integrations/google/oauth/callback"),
  "google.tracking_template": () => ADS_UTM_TEMPLATES.google,
  "tiktok.permissions": () => [...new Set(Object.values(TIKTOK_SCOPES_BY_MODULE).flat())].join(", "),
  "tiktok.utm_template": () => ADS_UTM_TEMPLATES.tiktok,
  "anthropic.console_url": () => "https://console.anthropic.com/settings/keys",
  "address.apis": () => GOOGLE_ADDRESS_APIS.join(", "),
  // the Spoki URL carries the tenant's secret token: only integration managers see it
  "spoki.webhook_url": (c) => (c.tenantId && c.canSeeSecrets ? spokiWebhookUrl(c.tenantId) : null),
  ...Object.fromEntries((["recharge", "loop", "shopify_subscriptions"] as const).flatMap((p) => [
    [`${p}.scopes`, () => SUBSCRIPTION_SCOPES[p].join(", ")],
    [`${p}.topics`, () => SUBSCRIPTION_WEBHOOK_TOPICS[p].join(", ")],
    [`${p}.webhook_url`, (c: SetupValueContext) => (c.tenantId ? apiEndpoint(`/webhooks/subscriptions/${c.tenantId}`) : null)],
  ])),
};

export function resolveSetupValues(guide: IntegrationSetupGuide, ctx: SetupValueContext = {}): Record<string, string> {
  return Object.fromEntries(setupCopyValues(guide).flatMap((id) => {
    const v = RESOLVERS[`${guide.provider}.${id}`]?.(ctx);
    return v ? [[id, v]] : [];
  }));
}

/** Whether the platform's own app/credentials a guide needs are configured (the simulator needs none). */
export function setupOwnerReady(guide: IntegrationSetupGuide): boolean {
  return integrationMode() === "mock" || ownerSetupReady(guide, process.env);
}

/** The demo values that make the simulator answer with each mapped error, shown on the card in mock mode only. */
export function mockSetupTriggers(provider: string): { value: string; code: string }[] {
  if (integrationMode() !== "mock") return [];
  return (MOCK_SETUP_TRIGGERS[provider] ?? []).filter((t) => t.field !== "oauth").map((t) => ({ value: t.value, code: t.expect }));
}

/** The three subscription apps' setup data for the subscription card (addon.subscriptions). */
export function subscriptionSetups(tenantId: string, slug: string) {
  const keys = Object.keys(SUBSCRIPTION_SETUPS) as (keyof typeof SUBSCRIPTION_SETUPS)[];
  return {
    values: Object.fromEntries(keys.map((k) => [k, resolveSetupValues(SUBSCRIPTION_SETUPS[k], { tenantId })])) as Record<keyof typeof SUBSCRIPTION_SETUPS, Record<string, string>>,
    triggers: Object.fromEntries(keys.map((k) => [k, mockSetupTriggers(k)])) as Record<keyof typeof SUBSCRIPTION_SETUPS, { value: string; code: string }[]>,
    guideHref: `/t/${slug}/integrations/guide/subscriptions`,
  };
}

/** The mock-only simulations each provider's card offers in its overflow menu (#90). */
export const CARD_SIMULATIONS: Readonly<Record<string, readonly string[]>> = { shopify: ["order", "cancel", "return", "bad_signature"], subscriptions: ["renewal", "renewal_declined"], accounting: ["failure"] };
