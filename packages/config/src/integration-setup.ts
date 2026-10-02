/**
 * Merchant self-setup of an integration (#86 GA4, #89 Shopify, and every card after them): what a card
 * shows so a store connects on its own, as plain data. The card (`IntegrationSetupChecklist` in
 * apps/web/src/components/integration-setup.tsx) renders the steps in order from message keys under
 * `namespace`, offers a copy button for each `copy` value it resolves at render time (a scope list, a
 * redirect URL, an e-mail), marks vendor-UI steps with the "To verify" badge, asks for the `fields` the
 * connect `strategy` needs, and turns a failed connect or test into the message and fix of its error code.
 * The guide page renders the same definition, so the card and the guide never disagree.
 */
export interface IntegrationSetupStep {
  key: string;
  /** Message key of the step's text, under the guide's namespace. */
  messageKey: string;
  /** Optional bold title above the text. */
  titleKey?: string;
  /** Value(s) the card resolves and shows with a copy button (e.g. `serviceAccountEmail`, `redirect_url`). */
  copy?: string | readonly string[];
  /** Points into the vendor's UI, which may have changed: shown with the "To verify" badge. */
  verify?: boolean;
  /** The step where the merchant types the value the connection needs (rendered as the form field). */
  input?: string;
}

/** How Connect obtains a credential (`platform_connection`: reuses another connection, e.g. Shopify Subscriptions through Shopify). */
export type SetupStrategy = "client_credentials" | "oauth_code" | "api_key" | "service_account" | "pasted_token" | "platform_connection";

/** A credential the card asks for (validated on the client and again on the server with `validateSetupFields`). */
export interface SetupField {
  name: string;
  /** Message key of the label, under the guide's namespace. */
  labelKey: string;
  /** Rendered as a password input and never echoed back. */
  secret?: boolean;
  placeholder?: string;
  /** Regular expression source the trimmed value must match (server side). */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  lowercase?: boolean;
  /** May be left empty (e.g. Meta's pixel id: without it the Conversions API stays off). */
  optional?: boolean;
}

export interface IntegrationSetupGuide<E extends string = string> {
  provider: string;
  /** i18n namespace of every key below. */
  namespace: string;
  titleKey: string;
  steps: readonly IntegrationSetupStep[];
  /** Plain-words outcome of a failed connect or test → message and fix keys (`{detail}` gets the vendor's words or the missing scopes). */
  errors: Readonly<Record<E, { messageKey: string; fixKey: string }>>;
  /** The manual path for stores that bring their own credentials. */
  advancedKey?: string;
  /** Connect strategy, and the one offered when the vendor refuses the first (Shopify: store outside the app's organization). */
  strategy?: SetupStrategy;
  fallbackStrategy?: SetupStrategy;
  /** Credentials Connect asks for, in order. */
  fields?: readonly SetupField[];
  /** Label message key of each copyable value. */
  copyLabels?: Readonly<Record<string, string>>;
  /** Message key of the last step's outcome, filled with what the adapter found (`{accounts}`, `{campaigns}`, `{orders}`…): shown after a successful connect or test. */
  verifiedKey?: string;
  /** Owner-side prerequisites of this path (the platform's own app, developer token…): the environment variables that must be set (docs/DEPLOY.md, "Production"). Without them the card says the path is not available yet. */
  ownerEnv?: readonly string[];
  /** Message key of the button of an `oauth_code` strategy ("Sign in with Google"). */
  oauthLabelKey?: string;
  /** Plain notes under the steps: vendor limits, paths not built yet. */
  noteKeys?: readonly string[];
}

/** Whether the owner-side prerequisites of a guide are configured (every `ownerEnv` variable set). */
export function ownerSetupReady(guide: IntegrationSetupGuide, env: Record<string, string | undefined>): boolean {
  return (guide.ownerEnv ?? []).every((k) => !!env[k]?.trim());
}

const setupStep = (key: string, extra: Partial<IntegrationSetupStep> = {}): IntegrationSetupStep => ({ key, titleKey: `steps.${key}.title`, messageKey: `steps.${key}.body`, ...extra });
const setupErrors = <E extends string>(codes: readonly E[]) => Object.fromEntries(codes.map((c) => [c, { messageKey: `errors.${c}.message`, fixKey: `errors.${c}.fix` }])) as Record<E, { messageKey: string; fixKey: string }>;

/** Every value a step offers to copy, in step order. */
export function setupCopyValues(guide: IntegrationSetupGuide): string[] {
  return guide.steps.flatMap((s) => (s.copy === undefined ? [] : typeof s.copy === "string" ? [s.copy] : [...s.copy]));
}

/** Validates the submitted fields of a guide; returns the cleaned values or the first invalid field. */
export function validateSetupFields(guide: IntegrationSetupGuide, input: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; field: string } {
  const values: Record<string, string> = {};
  for (const f of guide.fields ?? []) {
    let v = typeof input[f.name] === "string" ? (input[f.name] as string).trim() : "";
    if (f.lowercase) v = v.toLowerCase();
    if (!v && f.optional) {
      values[f.name] = "";
      continue;
    }
    if (!v || (f.minLength && v.length < f.minLength) || (f.maxLength && v.length > f.maxLength) || (f.pattern && !new RegExp(f.pattern).test(v))) return { ok: false, field: f.name };
    values[f.name] = v;
  }
  return { ok: true, values };
}

/** GA4 with the platform's service account (default): add the e-mail as Viewer, paste the property id, connect. */
export const GA4_SETUP = {
  provider: "ga4",
  namespace: "ga4.setup",
  titleKey: "title",
  steps: [
    { key: "open_admin", messageKey: "steps.open_admin", verify: true },
    { key: "access", messageKey: "steps.access", verify: true },
    { key: "add_viewer", messageKey: "steps.add_viewer", copy: "serviceAccountEmail", verify: true },
    { key: "property_id", messageKey: "steps.property_id", verify: true },
    { key: "paste", messageKey: "steps.paste", input: "propertyId" },
    { key: "connect", messageKey: "steps.connect" },
  ],
  errors: {
    no_access: { messageKey: "errors.no_access.message", fixKey: "errors.no_access.fix" },
    wrong_property: { messageKey: "errors.wrong_property.message", fixKey: "errors.wrong_property.fix" },
    api_unreachable: { messageKey: "errors.api_unreachable.message", fixKey: "errors.api_unreachable.fix" },
    quota: { messageKey: "errors.quota.message", fixKey: "errors.quota.fix" },
    credentials: { messageKey: "errors.credentials.message", fixKey: "errors.credentials.fix" },
    unknown: { messageKey: "errors.unknown.message", fixKey: "errors.unknown.fix" },
  },
  advancedKey: "advanced",
  strategy: "service_account",
  copyLabels: { serviceAccountEmail: "values.serviceAccountEmail" },
  verifiedKey: "verified",
} as const satisfies IntegrationSetupGuide<"no_access" | "wrong_property" | "api_unreachable" | "quota" | "credentials" | "unknown">;

type ShopifySetupError = "invalid_input" | "wrong_credentials" | "not_in_organization" | "not_installed" | "shop_not_found" | "version_not_released" | "missing_scopes" | "token_refresh_failed" | "install_not_ready" | "unknown";

/**
 * Shopify with the merchant's own Dev Dashboard app (#89): create the app, a version with the scopes,
 * release and install it, copy Client ID and secret, connect. Client credentials grant when the store is in
 * the app's organization; otherwise "Install on your store" (authorization code grant) with the same app.
 */
export const SHOPIFY_SETUP = {
  provider: "shopify",
  namespace: "integration_setup.shopify",
  titleKey: "title",
  strategy: "client_credentials",
  fallbackStrategy: "oauth_code",
  steps: [
    setupStep("create_app", { verify: true }),
    setupStep("scopes", { verify: true, copy: ["scopes_required", "scopes_optional", "compliance_url"] }),
    setupStep("release_install", { verify: true }),
    setupStep("credentials", { verify: true }),
    setupStep("connect", { copy: ["redirect_url", "app_url"] }),
  ],
  fields: [
    { name: "shop", labelKey: "fields.shop", placeholder: "my-store.myshopify.com", pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$", lowercase: true, maxLength: 120 },
    { name: "clientId", labelKey: "fields.clientId", minLength: 8, maxLength: 200 },
    { name: "clientSecret", labelKey: "fields.clientSecret", secret: true, minLength: 8, maxLength: 300 },
  ],
  copyLabels: { scopes_required: "values.scopes_required", scopes_optional: "values.scopes_optional", compliance_url: "values.compliance_url", redirect_url: "values.redirect_url", app_url: "values.app_url" },
  errors: setupErrors<ShopifySetupError>(["invalid_input", "wrong_credentials", "not_in_organization", "not_installed", "shop_not_found", "version_not_released", "missing_scopes", "token_refresh_failed", "install_not_ready", "unknown"]),
  advancedKey: "advanced",
} as const satisfies IntegrationSetupGuide<ShopifySetupError>;

export const META_SETUP_ERRORS = ["invalid_input", "invalid_token", "missing_permission", "account_not_assigned", "pixel_not_accessible", "rate_limited", "unknown"] as const;
/**
 * Meta Ads + Conversions API, pilot path (#90): a system user in the merchant's Business Manager with the
 * ad account(s) and the pixel assigned, a never-expiring system-user token, pasted with the account and
 * pixel ids. "Continue with Facebook" (the platform's Meta app) is a later path: `notes.facebook_login`.
 */
export const META_SETUP = {
  provider: "meta",
  namespace: "integration_setup.meta",
  titleKey: "title",
  strategy: "pasted_token",
  steps: [setupStep("system_user", { verify: true }), setupStep("assign_assets", { verify: true }), setupStep("token", { verify: true, copy: "permissions" }), setupStep("ids", { verify: true }), setupStep("url_parameters", { verify: true, copy: "utm_template" }), setupStep("connect"), setupStep("verify")],
  fields: [
    { name: "accessToken", labelKey: "fields.accessToken", secret: true, minLength: 20, maxLength: 600 },
    { name: "adAccountIds", labelKey: "fields.adAccountIds", placeholder: "act_123456789, act_987654321", pattern: "^(act_)?\\d{5,20}(\\s*,\\s*(act_)?\\d{5,20}){0,9}$", maxLength: 400 },
    { name: "pixelId", labelKey: "fields.pixelId", placeholder: "123456789012345", pattern: "^\\d{5,20}$", maxLength: 20, optional: true },
  ],
  copyLabels: { permissions: "values.permissions", utm_template: "values.utm_template" },
  errors: setupErrors(META_SETUP_ERRORS),
  verifiedKey: "verified",
  noteKeys: ["notes.advantage", "notes.facebook_login"],
} as const satisfies IntegrationSetupGuide<(typeof META_SETUP_ERRORS)[number]>;

/**
 * A Meta status change refused because the campaign is a legacy Advantage+ shopping or app campaign
 * (ASC/AAC: since Marketing API v25 apps can no longer pause or resume them). Cards and write badges
 * explain it in plain words instead of showing Meta's text.
 */
export function isMetaAdvantageLockedError(text: string | null | undefined): boolean {
  return !!text && /advantage\+?\s*(shopping|app)|\b(ASC|AAC)\b|smart.?promotion|automated.?shopping/i.test(text);
}

export const GOOGLE_ADS_SETUP_ERRORS = ["app_not_configured", "access_denied", "no_accounts", "developer_token", "not_enabled", "no_permission", "token_revoked", "rate_limited", "unknown"] as const;
/**
 * Google Ads (+ Enhanced Conversions) (#90): "Sign in with Google" with the platform's OAuth client and
 * developer token, then the merchant picks the account (accounts under a manager included). The
 * manual path with the store's own developer token stays under Advanced.
 */
export const GOOGLE_ADS_SETUP = {
  provider: "google",
  namespace: "integration_setup.google",
  titleKey: "title",
  strategy: "oauth_code",
  oauthLabelKey: "sign_in",
  ownerEnv: ["HULLWISE_GOOGLE_ADS_CLIENT_ID", "HULLWISE_GOOGLE_ADS_CLIENT_SECRET", "HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN"],
  steps: [setupStep("access", { verify: true }), setupStep("sign_in", { verify: true, copy: ["scope", "redirect_url"] }), setupStep("pick"), setupStep("tracking", { verify: true, copy: "tracking_template" }), setupStep("enhanced_conversions", { verify: true }), setupStep("verify")],
  copyLabels: { scope: "values.scope", redirect_url: "values.redirect_url", tracking_template: "values.tracking_template" },
  errors: setupErrors(GOOGLE_ADS_SETUP_ERRORS),
  verifiedKey: "verified",
  advancedKey: "advanced",
} as const satisfies IntegrationSetupGuide<(typeof GOOGLE_ADS_SETUP_ERRORS)[number]>;

export const TIKTOK_SETUP_ERRORS = ["app_not_configured", "access_denied", "no_advertisers", "missing_permission", "token_expired", "rate_limited", "unknown"] as const;
/** TikTok Ads (#90): "Connect TikTok" with the platform's approved TikTok for Business app; the store's own app stays under Advanced. */
export const TIKTOK_SETUP = {
  provider: "tiktok",
  namespace: "integration_setup.tiktok",
  titleKey: "title",
  strategy: "oauth_code",
  oauthLabelKey: "connect_tiktok",
  ownerEnv: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
  steps: [setupStep("access", { verify: true }), setupStep("authorize", { verify: true, copy: "permissions" }), setupStep("url_parameters", { verify: true, copy: "utm_template" }), setupStep("verify")],
  copyLabels: { permissions: "values.permissions", utm_template: "values.utm_template" },
  errors: setupErrors(TIKTOK_SETUP_ERRORS),
  verifiedKey: "verified",
  advancedKey: "advanced",
} as const satisfies IntegrationSetupGuide<(typeof TIKTOK_SETUP_ERRORS)[number]>;

export const ANTHROPIC_SETUP_ERRORS = ["invalid_input", "invalid_key", "no_credit", "rate_limited", "overloaded", "unknown"] as const;
/** The AI assistant (#90): the store's own Anthropic API key, billed by Anthropic to the store. */
export const ANTHROPIC_SETUP = {
  provider: "anthropic",
  namespace: "integration_setup.anthropic",
  titleKey: "title",
  strategy: "api_key",
  steps: [setupStep("account", { verify: true, copy: "console_url" }), setupStep("billing", { verify: true }), setupStep("key", { verify: true }), setupStep("connect"), setupStep("verify")],
  fields: [{ name: "apiKey", labelKey: "fields.apiKey", secret: true, placeholder: "sk-ant-…", pattern: "^sk-ant-[A-Za-z0-9_-]{8,}$", maxLength: 300 }],
  copyLabels: { console_url: "values.console_url" },
  errors: setupErrors(ANTHROPIC_SETUP_ERRORS),
  verifiedKey: "verified",
} as const satisfies IntegrationSetupGuide<(typeof ANTHROPIC_SETUP_ERRORS)[number]>;

export const ADDRESS_SETUP_ERRORS = ["invalid_input", "invalid_key", "api_not_enabled", "key_restricted", "billing_disabled", "quota", "unknown"] as const;
/** Address validation (#90): a Google Maps Platform key of the store with Address Validation API and Places API (New) enabled. */
export const ADDRESS_SETUP = {
  provider: "address",
  namespace: "integration_setup.address",
  titleKey: "title",
  strategy: "api_key",
  steps: [setupStep("project", { verify: true }), setupStep("billing", { verify: true }), setupStep("enable_apis", { verify: true, copy: "apis" }), setupStep("key", { verify: true }), setupStep("connect"), setupStep("verify")],
  fields: [{ name: "apiKey", labelKey: "fields.apiKey", secret: true, placeholder: "AIza…", minLength: 20, maxLength: 200 }],
  copyLabels: { apis: "values.apis" },
  errors: setupErrors(ADDRESS_SETUP_ERRORS),
  verifiedKey: "verified",
} as const satisfies IntegrationSetupGuide<(typeof ADDRESS_SETUP_ERRORS)[number]>;

export const SPOKI_SETUP_ERRORS = ["invalid_input", "invalid_key", "no_api_access", "rate_limited", "unknown"] as const;
/** WhatsApp with Spoki (addon.whatsapp_spoki, #90): the store's API key, and our per-tenant webhook URL pasted in Spoki. */
export const SPOKI_SETUP = {
  provider: "spoki",
  namespace: "integration_setup.spoki",
  titleKey: "title",
  strategy: "api_key",
  steps: [setupStep("account", { verify: true }), setupStep("key", { verify: true }), setupStep("webhook", { verify: true, copy: "webhook_url" }), setupStep("connect"), setupStep("verify")],
  fields: [{ name: "apiKey", labelKey: "fields.apiKey", secret: true, minLength: 16, maxLength: 200 }],
  copyLabels: { webhook_url: "values.webhook_url" },
  errors: setupErrors(SPOKI_SETUP_ERRORS),
  verifiedKey: "verified",
} as const satisfies IntegrationSetupGuide<(typeof SPOKI_SETUP_ERRORS)[number]>;

export const SUBSCRIPTION_SETUP_ERRORS = ["invalid_input", "invalid_token", "missing_scopes", "shopify_not_connected", "rate_limited", "unknown"] as const;
const tokenSubscriptionSetup = <P extends "recharge" | "loop">(provider: P) =>
  ({
    provider,
    namespace: `integration_setup.${provider}`,
    titleKey: "title",
    strategy: "api_key",
    steps: [setupStep("token", { verify: true, copy: "scopes" }), setupStep("secret", { verify: true }), setupStep("webhook", { verify: true, copy: ["webhook_url", "topics"] }), setupStep("connect"), setupStep("verify")],
    fields: [
      { name: "apiToken", labelKey: "fields.apiToken", secret: true, minLength: 16, maxLength: 400 },
      { name: "webhookSecret", labelKey: "fields.webhookSecret", secret: true, minLength: 8, maxLength: 400 },
    ],
    copyLabels: { scopes: "values.scopes", webhook_url: "values.webhook_url", topics: "values.topics" },
    errors: setupErrors(["invalid_input", "invalid_token", "missing_scopes", "rate_limited", "unknown"] as const),
    verifiedKey: "verified",
  }) as const satisfies IntegrationSetupGuide<Exclude<(typeof SUBSCRIPTION_SETUP_ERRORS)[number], "shopify_not_connected">>;
/** addon.subscriptions (#90): Recharge and Loop with an API token from their admin. */
export const RECHARGE_SETUP = tokenSubscriptionSetup("recharge");
export const LOOP_SETUP = tokenSubscriptionSetup("loop");
/** Shopify Subscriptions goes through the Shopify connection: contract scopes on the merchant's app (owner prerequisite: Shopify's approval to read contracts of other apps). */
export const SHOPIFY_SUBSCRIPTIONS_SETUP = {
  provider: "shopify_subscriptions",
  namespace: "integration_setup.shopify_subscriptions",
  titleKey: "title",
  strategy: "platform_connection",
  steps: [setupStep("shopify"), setupStep("scopes", { verify: true, copy: ["scopes", "topics"] }), setupStep("approval", { verify: true }), setupStep("connect"), setupStep("verify")],
  copyLabels: { scopes: "values.scopes", topics: "values.topics" },
  errors: setupErrors(["shopify_not_connected", "missing_scopes", "unknown"] as const),
  verifiedKey: "verified",
} as const satisfies IntegrationSetupGuide<"shopify_not_connected" | "missing_scopes" | "unknown">;
export const SUBSCRIPTION_SETUPS = { shopify_subscriptions: SHOPIFY_SUBSCRIPTIONS_SETUP, recharge: RECHARGE_SETUP, loop: LOOP_SETUP } as const;

/** The setup guides by provider (cards and guide pages look them up here). */
export const INTEGRATION_SETUP: Readonly<Record<string, IntegrationSetupGuide>> = { ga4: GA4_SETUP, shopify: SHOPIFY_SETUP, meta: META_SETUP, google: GOOGLE_ADS_SETUP, tiktok: TIKTOK_SETUP, anthropic: ANTHROPIC_SETUP, address: ADDRESS_SETUP, spoki: SPOKI_SETUP, ...SUBSCRIPTION_SETUPS };
export function integrationSetup(provider: string): IntegrationSetupGuide | null {
  return INTEGRATION_SETUP[provider] ?? null;
}
