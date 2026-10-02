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

/** How Connect obtains a credential. */
export type SetupStrategy = "client_credentials" | "oauth_code" | "api_key" | "service_account" | "pasted_token";

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
}

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
} as const satisfies IntegrationSetupGuide<"no_access" | "wrong_property" | "api_unreachable" | "quota" | "credentials" | "unknown">;

type ShopifySetupError = "invalid_input" | "wrong_credentials" | "not_in_organization" | "not_installed" | "shop_not_found" | "version_not_released" | "missing_scopes" | "token_refresh_failed" | "install_not_ready" | "unknown";
const shopifyError = (code: ShopifySetupError) => ({ messageKey: `errors.${code}.message`, fixKey: `errors.${code}.fix` });
const shopifyStep = (key: string, extra: Partial<IntegrationSetupStep> = {}): IntegrationSetupStep => ({ key, titleKey: `steps.${key}.title`, messageKey: `steps.${key}.body`, ...extra });

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
    shopifyStep("create_app", { verify: true }),
    shopifyStep("scopes", { verify: true, copy: ["scopes_required", "scopes_optional", "compliance_url"] }),
    shopifyStep("release_install", { verify: true }),
    shopifyStep("credentials", { verify: true }),
    shopifyStep("connect", { copy: ["redirect_url", "app_url"] }),
  ],
  fields: [
    { name: "shop", labelKey: "fields.shop", placeholder: "my-store.myshopify.com", pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$", lowercase: true, maxLength: 120 },
    { name: "clientId", labelKey: "fields.clientId", minLength: 8, maxLength: 200 },
    { name: "clientSecret", labelKey: "fields.clientSecret", secret: true, minLength: 8, maxLength: 300 },
  ],
  copyLabels: { scopes_required: "values.scopes_required", scopes_optional: "values.scopes_optional", compliance_url: "values.compliance_url", redirect_url: "values.redirect_url", app_url: "values.app_url" },
  errors: { invalid_input: shopifyError("invalid_input"), wrong_credentials: shopifyError("wrong_credentials"), not_in_organization: shopifyError("not_in_organization"), not_installed: shopifyError("not_installed"), shop_not_found: shopifyError("shop_not_found"), version_not_released: shopifyError("version_not_released"), missing_scopes: shopifyError("missing_scopes"), token_refresh_failed: shopifyError("token_refresh_failed"), install_not_ready: shopifyError("install_not_ready"), unknown: shopifyError("unknown") },
  advancedKey: "advanced",
} as const satisfies IntegrationSetupGuide<ShopifySetupError>;

/** The setup guides by provider (cards and guide pages look them up here). */
export const INTEGRATION_SETUP: Readonly<Record<string, IntegrationSetupGuide>> = { ga4: GA4_SETUP, shopify: SHOPIFY_SETUP };
export function integrationSetup(provider: string): IntegrationSetupGuide | null {
  return INTEGRATION_SETUP[provider] ?? null;
}
