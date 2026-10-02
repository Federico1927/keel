/**
 * Self-serve connection of an integration (issue #89): what the merchant does in the vendor's console and
 * what Hullwise asks for, as data. The card (`IntegrationSetup` in apps/web/src/components/integrations)
 * and the guide page render the same definition, so they never disagree. Texts live in the messages under
 * `integration_setup.<provider>`: `steps.<id>.title|body`, `values.<id>`, `fields.<name>`,
 * `errors.<code>.message|fix`; copyable values are resolved server side (`apps/web/src/server/integration-setup.ts`).
 */
export type SetupStrategy = "client_credentials" | "oauth_code" | "api_key" | "service_account" | "pasted_token";

export interface SetupStep {
  id: string;
  /** The step describes a vendor console that may have changed: shown with the "Da verificare" badge. */
  verify?: boolean;
  /** Copyable values shown under the step (ids of `copyValues`). */
  copy?: string[];
}

export interface SetupField {
  name: string;
  /** Rendered as a password input and never echoed back. */
  secret?: boolean;
  placeholder?: string;
  /** Regular expression source the trimmed value must match (client and server). */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  lowercase?: boolean;
}

export interface IntegrationSetupDefinition {
  provider: string;
  /** How Connect gets a credential; `fallbackStrategy` runs when the vendor refuses the first one. */
  strategy: SetupStrategy;
  fallbackStrategy?: SetupStrategy;
  steps: SetupStep[];
  /** Values with a copy button (scope lists, redirect and webhook URLs, service account emails…). */
  copyValues: string[];
  fields: SetupField[];
  /** Error codes Connect and Test connection can answer with, each with a message and the fix. */
  errors: string[];
}

export const SHOPIFY_SETUP: IntegrationSetupDefinition = {
  provider: "shopify",
  strategy: "client_credentials",
  fallbackStrategy: "oauth_code",
  steps: [
    { id: "create_app", verify: true },
    { id: "scopes", verify: true, copy: ["scopes_required", "scopes_optional", "compliance_url"] },
    { id: "release_install", verify: true },
    { id: "credentials", verify: true },
    { id: "connect", copy: ["redirect_url", "app_url"] },
  ],
  copyValues: ["scopes_required", "scopes_optional", "compliance_url", "redirect_url", "app_url"],
  fields: [
    { name: "shop", placeholder: "my-store.myshopify.com", pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$", lowercase: true, maxLength: 120 },
    { name: "clientId", minLength: 8, maxLength: 200 },
    { name: "clientSecret", secret: true, minLength: 8, maxLength: 300 },
  ],
  errors: ["invalid_input", "wrong_credentials", "not_in_organization", "not_installed", "shop_not_found", "version_not_released", "missing_scopes", "token_refresh_failed", "install_not_ready", "unknown"],
};

export const INTEGRATION_SETUP: Record<string, IntegrationSetupDefinition> = { shopify: SHOPIFY_SETUP };

export function integrationSetup(provider: string): IntegrationSetupDefinition | null {
  return INTEGRATION_SETUP[provider] ?? null;
}

/** Validates the submitted fields of a definition; returns the cleaned values or the first invalid field. */
export function validateSetupFields(def: IntegrationSetupDefinition, input: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; field: string } {
  const values: Record<string, string> = {};
  for (const f of def.fields) {
    let v = typeof input[f.name] === "string" ? (input[f.name] as string).trim() : "";
    if (f.lowercase) v = v.toLowerCase();
    if (!v || (f.minLength && v.length < f.minLength) || (f.maxLength && v.length > f.maxLength) || (f.pattern && !new RegExp(f.pattern).test(v))) return { ok: false, field: f.name };
    values[f.name] = v;
  }
  return { ok: true, values };
}

/** Historical import (issue #87): months of orders imported when a store connects; 0 = all orders. */
export const HISTORY_IMPORT_DEFAULT_MONTHS = 24;
export const HISTORY_IMPORT_MONTH_OPTIONS = [6, 12, 24, 36, 0] as const;
