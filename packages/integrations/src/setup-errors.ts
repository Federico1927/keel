import { ADDRESS_SETUP_ERRORS, ANTHROPIC_SETUP_ERRORS, GOOGLE_ADS_SETUP_ERRORS, META_SETUP_ERRORS, SPOKI_SETUP_ERRORS, SUBSCRIPTION_SETUP_ERRORS, TIKTOK_SETUP_ERRORS } from "@hullwise/config";
import type { ConnectionTest } from "./types";

/**
 * Plain-words outcome of a failed connect or connection test (#90): which problem the merchant has, so
 * the card shows its message and fix (`IntegrationSetupGuide.errors` in @hullwise/config). Read from the
 * adapter's error code (`IntegrationError["code"]`, or a setup code passed through such as
 * `access_denied`), the vendor's message and, for checks in several steps, the step that failed.
 * Pure: the live adapters and the mock triggers (mock/setup.ts) go through the same functions.
 */
export interface SetupFailure {
  code?: string | null;
  message?: string | null;
  /** The check that failed when a connect has several (Meta: `account` or `pixel`). */
  stage?: string | null;
}

type MetaSetupError = (typeof META_SETUP_ERRORS)[number];
type GoogleAdsSetupError = (typeof GOOGLE_ADS_SETUP_ERRORS)[number];
type TiktokSetupError = (typeof TIKTOK_SETUP_ERRORS)[number];
type AnthropicSetupError = (typeof ANTHROPIC_SETUP_ERRORS)[number];
type AddressSetupError = (typeof ADDRESS_SETUP_ERRORS)[number];
type SpokiSetupError = (typeof SPOKI_SETUP_ERRORS)[number];
type SubscriptionSetupError = (typeof SUBSCRIPTION_SETUP_ERRORS)[number];

/** A code that is already one of the guide's (passed through by OAuth callbacks and pre-checks). */
const passthrough = <E extends string>(codes: readonly E[], code: string | null | undefined): E | null => (code && (codes as readonly string[]).includes(code) ? (code as E) : null);
const has = (m: string, re: RegExp) => re.test(m);

export function metaSetupError(f: SetupFailure): MetaSetupError {
  const m = f.message ?? "";
  const known = passthrough(META_SETUP_ERRORS, f.code);
  if (known) return known;
  if (f.code === "token_expired" || has(m, /\b190\b|error validating access token|invalid oauth (2\.0 )?access token|session has expired|access token .*(expired|invalid)/i)) return "invalid_token";
  if (f.code === "rate_limited" || has(m, /\(#(4|17|32|613|80004)\)|request limit reached|too many calls/i)) return "rate_limited";
  if (f.stage === "pixel") return "pixel_not_accessible";
  if (has(m, /does not exist, cannot be loaded due to missing permissions|object with id '?act_/i) || (f.stage === "account" && (f.code === "not_found" || f.code === "invalid_request"))) return "account_not_assigned";
  if (f.code === "permission" || has(m, /\(#(10|200|294)\)|requires .*permission|ads_management|ads_read|not enough permission/i)) return "missing_permission";
  return "unknown";
}

export function googleAdsSetupError(f: SetupFailure): GoogleAdsSetupError {
  const m = f.message ?? "";
  const known = passthrough(GOOGLE_ADS_SETUP_ERRORS, f.code);
  if (known) return known;
  if (has(m, /access_denied/i)) return "access_denied";
  if (has(m, /DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)|developer token is (only approved for use with test accounts|not approved)/i)) return "developer_token";
  if (has(m, /CUSTOMER_NOT_ENABLED|not yet enabled or has been deactivated/i)) return "not_enabled";
  if (f.code === "token_expired" || has(m, /invalid_grant|token has been expired or revoked|UNAUTHENTICATED/i)) return "token_revoked";
  if (f.code === "rate_limited" || has(m, /RESOURCE_EXHAUSTED|too many requests/i)) return "rate_limited";
  if (has(m, /no (accessible )?(google ads )?(customers|accounts)/i)) return "no_accounts";
  if (f.code === "permission" || has(m, /USER_PERMISSION_DENIED|PERMISSION_DENIED|doesn't have permission to access customer/i)) return "no_permission";
  return "unknown";
}

export function tiktokSetupError(f: SetupFailure): TiktokSetupError {
  const m = f.message ?? "";
  const known = passthrough(TIKTOK_SETUP_ERRORS, f.code);
  if (known) return known;
  if (has(m, /access_denied|cancel+ed the authori[sz]ation/i)) return "access_denied";
  if (f.code === "token_expired" || has(m, /\b4010[25]\b|access token is invalid|has been revoked|auth(orization)? code (has )?expired/i)) return "token_expired";
  if (f.code === "rate_limited" || has(m, /\b40100\b|too many requests/i)) return "rate_limited";
  if (has(m, /no advertiser/i)) return "no_advertisers";
  if (f.code === "permission" || has(m, /\b40001\b|no permission|permission denied|scope/i)) return "missing_permission";
  return "unknown";
}

export function anthropicSetupError(f: SetupFailure): AnthropicSetupError {
  const m = f.message ?? "";
  const known = passthrough(ANTHROPIC_SETUP_ERRORS, f.code);
  if (known) return known;
  if (has(m, /credit balance is too low|purchase credits|plans & billing|billing/i)) return "no_credit";
  if (f.code === "token_expired" || f.code === "permission" || has(m, /^auth:|authentication_error|permission_error|invalid x-api-key|\b401\b/i)) return "invalid_key";
  if (f.code === "rate_limited" || has(m, /^rate_limited:|rate_limit_error|\b429\b/i)) return "rate_limited";
  if (has(m, /^overloaded:|overloaded_error|\b529\b/i)) return "overloaded";
  return "unknown";
}

export function addressSetupError(f: SetupFailure): AddressSetupError {
  const m = f.message ?? "";
  const known = passthrough(ADDRESS_SETUP_ERRORS, f.code);
  if (known) return known;
  if (has(m, /BILLING_DISABLED|billing/i)) return "billing_disabled";
  if (has(m, /API_KEY_\w*_BLOCKED|are blocked|key .*restricted|is restricted/i)) return "key_restricted";
  if (has(m, /SERVICE_DISABLED|not enabled|has not been used in project|is disabled/i)) return "api_not_enabled";
  if (f.code === "token_expired" || has(m, /API_KEY_INVALID|API key not valid|rejected the API key/i)) return "invalid_key";
  if (f.code === "rate_limited" || has(m, /RESOURCE_EXHAUSTED|quota/i)) return "quota";
  return "unknown";
}

export function spokiSetupError(f: SetupFailure): SpokiSetupError {
  const m = f.message ?? "";
  const known = passthrough(SPOKI_SETUP_ERRORS, f.code);
  if (known) return known;
  if (f.code === "token_expired" || has(m, /\b401\b|invalid (api )?key|authentication/i)) return "invalid_key";
  if (f.code === "rate_limited" || has(m, /\b429\b/)) return "rate_limited";
  if (f.code === "permission" || has(m, /\b403\b|not allowed|plan/i)) return "no_api_access";
  return "unknown";
}

export function subscriptionSetupError(f: SetupFailure): SubscriptionSetupError {
  const m = f.message ?? "";
  const known = passthrough(SUBSCRIPTION_SETUP_ERRORS, f.code);
  if (known) return known;
  if (has(m, /missing scopes?|insufficient scope|access denied for scope/i)) return "missing_scopes";
  if (f.code === "token_expired" || has(m, /\b401\b|invalid (api )?token|unauthori[sz]ed/i)) return "invalid_token";
  if (f.code === "rate_limited" || has(m, /\b429\b/)) return "rate_limited";
  if (f.code === "permission" || has(m, /\b403\b/)) return "missing_scopes";
  return "unknown";
}

const CLASSIFIERS: Readonly<Record<string, (f: SetupFailure) => string>> = { meta: metaSetupError, google: googleAdsSetupError, tiktok: tiktokSetupError, anthropic: anthropicSetupError, address: addressSetupError, spoki: spokiSetupError, recharge: subscriptionSetupError, loop: subscriptionSetupError, shopify_subscriptions: subscriptionSetupError };

/** The setup error code of a provider's failure (`unknown` when nothing more specific applies); null for a provider without a self-setup guide. */
export function classifySetupError(provider: string, f: SetupFailure): string | null {
  const c = CLASSIFIERS[provider];
  return c ? c(f) : null;
}

/** The same, from a failed connection test. */
export function setupErrorOfTest(provider: string, test: Pick<ConnectionTest, "error" | "errorCode">, stage?: string): string | null {
  return classifySetupError(provider, { code: test.errorCode ?? null, message: test.error ?? null, stage: stage ?? null });
}

/** The same, from an integration's stored last error (`[code] message`, or the plain message). */
export function setupErrorFromText(provider: string, text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^\[(\w+)\]\s*(.*)$/s.exec(text);
  return classifySetupError(provider, { code: m?.[1] ?? null, message: m?.[2] ?? text });
}
