import type { GoogleAdsAccountOption } from "../google/oauth";
import type { IntegrationError } from "../types";

/**
 * Mock mode of the merchant self-setup (#90): deterministic trigger values make the simulated vendor
 * answer like the real one does on each mapped error (Shopify's equivalent is the `missing-scopes` Client
 * ID). The failure carries the vendor's own wording and error code, so it reaches the card through the
 * same classifier as a live failure (setup-errors.ts). A value matches when the field contains it.
 */
export interface SimulatedSetupFailure {
  errorCode: IntegrationError["code"] | "access_denied";
  error: string;
  /** The check that fails (Meta: `account` or `pixel`). */
  stage?: string;
}
export interface MockSetupTrigger {
  field: string;
  value: string;
  /** The setup error code the card shows (asserted by the tests). */
  expect: string;
  failure: SimulatedSetupFailure;
}

const NOT_FOUND = (id: string) => `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`;

export const MOCK_SETUP_TRIGGERS: Readonly<Record<string, readonly MockSetupTrigger[]>> = {
  meta: [
    { field: "accessToken", value: "expired-token-demo", expect: "invalid_token", failure: { stage: "account", errorCode: "token_expired", error: "Error validating access token: Session has expired on Thursday, 01-Oct-26 10:00:00 PDT." } },
    { field: "accessToken", value: "no-permission-demo", expect: "missing_permission", failure: { stage: "account", errorCode: "permission", error: "(#200) Requires ads_management permission to manage the object" } },
    { field: "accessToken", value: "rate-limit-demo", expect: "rate_limited", failure: { stage: "account", errorCode: "rate_limited", error: "(#17) User request limit reached" } },
    { field: "adAccountIds", value: "404404404", expect: "account_not_assigned", failure: { stage: "account", errorCode: "invalid_request", error: NOT_FOUND("act_404404404") } },
    { field: "pixelId", value: "404404404", expect: "pixel_not_accessible", failure: { stage: "pixel", errorCode: "invalid_request", error: NOT_FOUND("404404404") } },
  ],
  google: [
    { field: "oauth", value: "access_denied", expect: "access_denied", failure: { errorCode: "access_denied", error: "access_denied" } },
    { field: "customerId", value: "1111111111", expect: "not_enabled", failure: { errorCode: "permission", error: "CUSTOMER_NOT_ENABLED: The customer account can't be accessed because it is not yet enabled or has been deactivated." } },
    { field: "customerId", value: "2222222222", expect: "developer_token", failure: { errorCode: "permission", error: "DEVELOPER_TOKEN_NOT_APPROVED: The developer token is only approved for use with test accounts. To access non-test accounts, apply for Basic or Standard access." } },
    { field: "oauth", value: "no_accounts", expect: "no_accounts", failure: { errorCode: "not_found", error: "No accessible Google Ads accounts for this Google user" } },
    { field: "oauth", value: "invalid_grant", expect: "token_revoked", failure: { errorCode: "token_expired", error: "invalid_grant: Token has been expired or revoked." } },
    { field: "customerId", value: "4444444444", expect: "rate_limited", failure: { errorCode: "rate_limited", error: "RESOURCE_EXHAUSTED: Too many requests. Retry in 30 seconds." } },
    { field: "customerId", value: "3333333333", expect: "no_permission", failure: { errorCode: "permission", error: "USER_PERMISSION_DENIED: User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer id must be set in the 'login-customer-id' header." } },
  ],
  tiktok: [
    { field: "oauth", value: "access_denied", expect: "access_denied", failure: { errorCode: "access_denied", error: "access_denied: the user cancelled the authorization" } },
    { field: "oauth", value: "no_advertisers", expect: "no_advertisers", failure: { errorCode: "not_found", error: "The authorization covers no advertiser account" } },
    { field: "oauth", value: "no_permission", expect: "missing_permission", failure: { errorCode: "permission", error: "40001: No permission to operate advertiser. Please check the permission scope of the app." } },
    { field: "oauth", value: "code_expired", expect: "token_expired", failure: { errorCode: "token_expired", error: "40105: The auth code has expired or has been used." } },
    { field: "oauth", value: "rate_limited", expect: "rate_limited", failure: { errorCode: "rate_limited", error: "40100: Too many requests." } },
  ],
  anthropic: [
    { field: "apiKey", value: "invalid-key-demo", expect: "invalid_key", failure: { errorCode: "token_expired", error: 'auth: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' } },
    { field: "apiKey", value: "no-credit-demo", expect: "no_credit", failure: { errorCode: "invalid_request", error: "bad_request: 400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
    { field: "apiKey", value: "rate-limit-demo", expect: "rate_limited", failure: { errorCode: "rate_limited", error: 'rate_limited: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}' } },
    { field: "apiKey", value: "overloaded-demo", expect: "overloaded", failure: { errorCode: "network", error: 'overloaded: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' } },
  ],
  address: [
    { field: "apiKey", value: "invalid-key-demo", expect: "invalid_key", failure: { errorCode: "token_expired", error: "Google rejected the API key (invalid or deleted)" } },
    { field: "apiKey", value: "api-not-enabled-demo", expect: "api_not_enabled", failure: { errorCode: "permission", error: "The Address Validation API or Places API (New) is not enabled on the Google Cloud project (SERVICE_DISABLED)" } },
    { field: "apiKey", value: "key-restricted-demo", expect: "key_restricted", failure: { errorCode: "permission", error: "Google rejected the API key: it is restricted (API_KEY_SERVICE_BLOCKED or an application restriction) and does not allow this API from a server" } },
    { field: "apiKey", value: "quota-demo", expect: "quota", failure: { errorCode: "rate_limited", error: "HTTP 429: Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' (RESOURCE_EXHAUSTED)" } },
    { field: "apiKey", value: "billing-disabled-demo", expect: "billing_disabled", failure: { errorCode: "permission", error: "Billing is not enabled on the Google Cloud project (BILLING_DISABLED)" } },
  ],
  spoki: [
    { field: "apiKey", value: "invalid-key-demo", expect: "invalid_key", failure: { errorCode: "token_expired", error: 'HTTP 401: {"detail":"Invalid API key."}' } },
    { field: "apiKey", value: "no-api-plan-demo", expect: "no_api_access", failure: { errorCode: "permission", error: 'HTTP 403: {"detail":"Your plan does not include API access."}' } },
    { field: "apiKey", value: "rate-limit-demo", expect: "rate_limited", failure: { errorCode: "rate_limited", error: "HTTP 429: Too many requests" } },
  ],
  recharge: [
    { field: "apiToken", value: "invalid-token-demo", expect: "invalid_token", failure: { errorCode: "token_expired", error: 'HTTP 401: {"errors":"Invalid API token"}' } },
    { field: "apiToken", value: "missing-scopes-demo", expect: "missing_scopes", failure: { errorCode: "permission", error: 'HTTP 403: {"errors":"Token does not have the required scopes: read_subscriptions"}' } },
    { field: "apiToken", value: "rate-limit-demo", expect: "rate_limited", failure: { errorCode: "rate_limited", error: "HTTP 429: Too Many Requests" } },
  ],
  loop: [
    { field: "apiToken", value: "invalid-token-demo", expect: "invalid_token", failure: { errorCode: "token_expired", error: 'HTTP 401: {"success":false,"message":"Unauthorized"}' } },
    { field: "apiToken", value: "missing-scopes-demo", expect: "missing_scopes", failure: { errorCode: "permission", error: 'HTTP 403: {"success":false,"message":"Missing scopes: subscriptions:read"}' } },
    { field: "apiToken", value: "rate-limit-demo", expect: "rate_limited", failure: { errorCode: "rate_limited", error: "HTTP 429: Too Many Requests" } },
  ],
};

/** The simulated vendor's answer to these setup values: the first trigger they contain, or null (the check passes). */
export function simulateSetupCheck(provider: string, values: Record<string, string | null | undefined>): SimulatedSetupFailure | null {
  for (const t of MOCK_SETUP_TRIGGERS[provider] ?? []) {
    if ((values[t.field] ?? "").toLowerCase().includes(t.value)) return t.failure;
  }
  return null;
}

/**
 * The accounts of the simulated Google sign-in: one with direct access, two under an agency's manager
 * account, and three whose ids trigger the mapped errors (MOCK_SETUP_TRIGGERS.google).
 */
export function mockGoogleAdsAccounts(storeName: string, currency: string | null = null): GoogleAdsAccountOption[] {
  const manager = { loginCustomerId: "9000000001", managerName: "Agency manager (MCC)" };
  return [
    { customerId: "4815162342", name: storeName, loginCustomerId: null, managerName: null, currency },
    { customerId: "4815162343", name: `${storeName} – second market`, ...manager, currency },
    { customerId: "1111111111", name: "Closed account (demo: not enabled)", ...manager, currency },
    { customerId: "2222222222", name: "Production account (demo: developer token pending)", loginCustomerId: null, managerName: null, currency },
    { customerId: "3333333333", name: "Account without access (demo)", loginCustomerId: null, managerName: null, currency },
  ];
}
