import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpClient } from "../http";
import { IntegrationError } from "../types";

/**
 * Minimum Admin API scopes per Hullwise module; the installer asks only for what the account needs.
 * Write scopes imply read access (Shopify: "any scope that writes a resource also grants read access").
 */
export const SHOPIFY_SCOPES_BY_MODULE: Record<string, string[]> = {
  "core.orders": ["read_orders", "write_orders", "read_customers", "read_fulfillments", "read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"],
  "core.shipments": ["read_fulfillments", "read_shipping", "write_merchant_managed_fulfillment_orders"],
  "core.catalog": ["read_products", "write_products", "read_inventory", "write_inventory", "read_locations", "read_publications"],
  "core.crm": ["read_customers"],
  "core.discounts": ["read_discounts", "write_discounts"],
  "core.returns": ["read_returns", "write_returns", "write_inventory"],
  // order editing (discount on an existing order, line changes) and invoices go through draft orders and order edits
  "core.order_edits": ["write_order_edits", "write_draft_orders"],
  // payouts and balance transactions: actual payment fees in the P/L and the payouts page
  "core.analytics": ["read_orders", "read_shopify_payments_payouts"],
};
/** Modules every store needs for the core to work; the others light up one feature each (optional). */
export const SHOPIFY_REQUIRED_MODULES = ["core.orders", "core.shipments", "core.catalog", "core.crm"] as const;
export const SHOPIFY_ALL_SCOPES = [...new Set(Object.values(SHOPIFY_SCOPES_BY_MODULE).flat())];
export const SHOPIFY_REQUIRED_SCOPES = [...new Set(SHOPIFY_REQUIRED_MODULES.flatMap((m) => SHOPIFY_SCOPES_BY_MODULE[m] ?? []))];
export const SHOPIFY_OPTIONAL_SCOPES = SHOPIFY_ALL_SCOPES.filter((s) => !SHOPIFY_REQUIRED_SCOPES.includes(s));
export const SHOPIFY_WEBHOOK_TOPICS = ["orders/create", "orders/updated", "orders/cancelled", "orders/paid", "orders/fulfilled", "products/create", "products/update", "products/delete", "inventory_levels/update", "fulfillments/create", "fulfillments/update", "refunds/create", "returns/request", "returns/approve", "returns/decline", "returns/cancel", "returns/close", "customers/create", "customers/update", "app/uninstalled"];
/** Mandatory privacy (GDPR) topics of any app that may be distributed: configured on the app, delivered to one endpoint. */
export const SHOPIFY_COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];
/** Admin API version every call is pinned to; `API_VERSION_SUPPORT` (../versions) says until when Shopify supports it. */
export const SHOPIFY_API_VERSION = "2026-10";

/** Granted scopes → what is missing, split into required and optional, and per module (write implies read). */
export function missingShopifyScopes(granted: readonly string[]): { required: string[]; optional: string[]; byModule: Record<string, string[]> } {
  const has = (s: string) => granted.includes(s) || (s.startsWith("read_") && granted.includes(s.replace("read_", "write_")));
  const byModule: Record<string, string[]> = {};
  for (const [mod, scopes] of Object.entries(SHOPIFY_SCOPES_BY_MODULE)) {
    const missing = scopes.filter((s) => !has(s));
    if (missing.length) byModule[mod] = missing;
  }
  return { required: SHOPIFY_REQUIRED_SCOPES.filter((s) => !has(s)), optional: SHOPIFY_OPTIONAL_SCOPES.filter((s) => !has(s)), byModule };
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

export function buildInstallUrl(shop: string, apiKey: string, scopes: string[], redirectUri: string, state: string): string {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", apiKey);
  u.searchParams.set("scope", scopes.join(","));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

/** Random nonce for OAuth flows that keep their state in a cookie (TikTok); Shopify uses `signState`. */
export function newOAuthState(): string {
  return randomBytes(16).toString("hex");
}

/** Shopify signs the callback query with HMAC-SHA256 (hex) over the sorted params minus `hmac`. */
export function verifyOAuthCallback(query: Record<string, string | undefined>, apiSecret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .filter((k) => rest[k] !== undefined)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  return digest.length === hmac.length && timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
}

/** Webhooks are signed with base64 HMAC-SHA256 of the raw body using the app secret. */
export function verifyWebhookHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(header, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ShopifyToken {
  accessToken: string;
  scopes: string[];
  /** ISO time the token stops working (client credentials: 24 h; expiring offline tokens); null = no expiry. */
  expiresAt: string | null;
  refreshToken?: string | null;
}

/**
 * Why Shopify refused a token request, in words the card can turn into a fix. Shopify's error bodies are
 * matched loosely (`shop_not_permitted` is documented for the client credentials grant; the other
 * patterns are "Da verificare" on a live store).
 */
export type ShopifyGrantFailure = "wrong_credentials" | "not_in_organization" | "not_installed" | "shop_not_found" | "unknown";
export class ShopifyGrantError extends IntegrationError {
  constructor(readonly reason: ShopifyGrantFailure, message: string) {
    super(reason === "wrong_credentials" ? "token_expired" : reason === "shop_not_found" ? "not_found" : "permission", message);
    this.name = "ShopifyGrantError";
  }
}

export function classifyGrantFailure(status: number, body: string): ShopifyGrantFailure {
  if (/shop_not_permitted|cannot be performed on this shop|organi[sz]ation/i.test(body)) return "not_in_organization";
  if (/not.?installed|app_not_installed|installation/i.test(body)) return "not_installed";
  if (/invalid_client|client.?(id|secret|authentication)|invalid api key|unauthori[sz]ed/i.test(body) || status === 401) return "wrong_credentials";
  if (status === 404 || /shop.*not found|unavailable shop/i.test(body)) return "shop_not_found";
  return "unknown";
}

function parseToken(json: { access_token?: string; scope?: string; expires_in?: number; refresh_token?: string }, now: number): ShopifyToken {
  if (!json.access_token) throw new ShopifyGrantError("unknown", "Shopify answered without an access token");
  return { accessToken: json.access_token, scopes: (json.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean), expiresAt: json.expires_in ? new Date(now + json.expires_in * 1000).toISOString() : null, ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}) };
}

/** POST to the shop's token endpoint; Shopify's refusal becomes a `ShopifyGrantError` with a reason. */
async function tokenRequest(shop: string, params: Record<string, string>, http: HttpClient, now: () => number): Promise<ShopifyToken> {
  try {
    const res = await http.request<{ access_token?: string; scope?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string }>(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(params).toString() });
    if (res.json?.error) throw new ShopifyGrantError(classifyGrantFailure(res.status, `${res.json.error} ${res.json.error_description ?? ""}`), `${res.json.error}: ${res.json.error_description ?? ""}`.trim());
    return parseToken(res.json ?? {}, now());
  } catch (e) {
    if (e instanceof ShopifyGrantError) throw e;
    if (e instanceof IntegrationError && e.code !== "network" && e.code !== "rate_limited") {
      const status = Number(/HTTP (\d+)/.exec(e.message)?.[1] ?? 0);
      throw new ShopifyGrantError(classifyGrantFailure(status, e.message), e.message);
    }
    throw e;
  }
}

/**
 * Client credentials grant (Dev Dashboard app and store in the same Shopify organization): the app's own
 * Client ID and secret buy a 24-hour token; the answer's `scope` lists what the released app version grants.
 * Refused with `shop_not_permitted` on a store outside the organization (then: authorization code grant).
 */
export function requestClientCredentialsToken(shop: string, clientId: string, clientSecret: string, http: HttpClient = new HttpClient(), now: () => number = Date.now): Promise<ShopifyToken> {
  return tokenRequest(shop, { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }, http, now);
}

/** Expiring offline token → a new one (`grant_type=refresh_token`; Da verificare on a live store). */
export function refreshShopifyToken(shop: string, clientId: string, clientSecret: string, refreshToken: string, http: HttpClient = new HttpClient(), now: () => number = Date.now): Promise<ShopifyToken> {
  return tokenRequest(shop, { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }, http, now);
}

/** Authorization code grant: the code from the callback → the store's offline token (with its expiry when Shopify sends one). */
export async function exchangeOAuthCode(shop: string, apiKey: string, apiSecret: string, code: string, http: HttpClient = new HttpClient(), now: () => number = Date.now): Promise<ShopifyToken> {
  return tokenRequest(shop, { client_id: apiKey, client_secret: apiSecret, code }, http, now);
}

/** Values of Shopify's ReturnReason enum, chosen per return reason in Hullwise (empty = OTHER). */
export const SHOPIFY_RETURN_REASONS = ["COLOR", "DEFECTIVE", "NOT_AS_DESCRIBED", "OTHER", "SIZE_TOO_LARGE", "SIZE_TOO_SMALL", "STYLE", "UNKNOWN", "UNWANTED", "WRONG_ITEM"] as const;
