import { PRODUCT_NAME } from "@hullwise/config";
import { IntegrationError } from "../types";
import { parseGa4ServiceAccount, type Ga4ServiceAccount } from "./index";

type Env = Record<string, string | undefined>;

/**
 * The platform's own GA4 reader (#86, default connection path): one service account owned by the
 * platform; each store adds its e-mail as Viewer on its GA4 property and pastes the property id.
 * `HULLWISE_GA4_SERVICE_ACCOUNT_KEY` holds the key file (JSON, or the same JSON base64-encoded);
 * `HULLWISE_GA4_SERVICE_ACCOUNT_EMAIL` the address the card shows (defaults to the key's client_email).
 */
export function platformGa4ServiceAccount(env: Env = process.env): Ga4ServiceAccount | null {
  const raw = env.HULLWISE_GA4_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    return parseGa4ServiceAccount(json);
  } catch {
    return null;
  }
}

/** Placeholder address the card shows in mock mode (no key configured): obviously not a real account. */
export function mockGa4ServiceAccountEmail(): string {
  return `ga4-reader@${PRODUCT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-demo.iam.gserviceaccount.com`;
}

/** The e-mail a store adds as Viewer: the configured one, the key's, the mock placeholder outside live mode, else null (not configured). */
export function ga4ServiceAccountEmail(env: Env = process.env): string | null {
  const configured = env.HULLWISE_GA4_SERVICE_ACCOUNT_EMAIL?.trim() || platformGa4ServiceAccount(env)?.client_email || null;
  if (configured) return configured;
  return env.HULLWISE_INTEGRATION_MODE === "live" ? null : mockGa4ServiceAccountEmail();
}

/** The platform key, or a readable error when a live store relies on it and it is not configured. */
export function requirePlatformGa4ServiceAccount(env: Env = process.env): Ga4ServiceAccount {
  const sa = platformGa4ServiceAccount(env);
  if (!sa) throw new IntegrationError("permission", "The platform's GA4 service account is not configured (HULLWISE_GA4_SERVICE_ACCOUNT_KEY): contact support");
  return sa;
}

/**
 * Plain-words outcome of a GA4 connection test, for the setup checklist: which problem the merchant
 * has and therefore which fix to show. Read from the adapter's error code and message.
 */
export const GA4_SETUP_ERRORS = ["no_access", "wrong_property", "api_unreachable", "quota", "credentials", "unknown"] as const;
export type Ga4SetupError = (typeof GA4_SETUP_ERRORS)[number];

export function ga4SetupError(code: string | null | undefined, message: string | null | undefined): Ga4SetupError {
  const m = message ?? "";
  if (/not enabled|not been used in project|is disabled|SERVICE_DISABLED|not configured/i.test(m)) return "api_unreachable";
  if (code === "permission") return "no_access";
  if (code === "not_found" || code === "invalid_request") return "wrong_property";
  if (code === "rate_limited") return "quota";
  if (code === "token_expired") return "credentials";
  if (code === "network") return "api_unreachable";
  return "unknown";
}

/** The same, from a stored `[code] message` error (the integration's last error). */
export function ga4SetupErrorFromText(text: string | null | undefined): Ga4SetupError | null {
  if (!text) return null;
  const m = /^\[(\w+)\]\s*(.*)$/s.exec(text);
  return ga4SetupError(m?.[1] ?? null, m?.[2] ?? text);
}
