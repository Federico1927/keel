import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Minimum Admin API scopes per Keel module; the installer asks only for what the account needs. */
export const SHOPIFY_SCOPES_BY_MODULE: Record<string, string[]> = {
  "core.orders": ["read_orders", "write_orders", "read_customers", "read_fulfillments", "read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"],
  "core.shipments": ["read_fulfillments", "read_shipping"],
  "core.catalog": ["read_products", "write_products", "read_inventory", "write_inventory", "read_locations"],
  "core.discounts": ["read_discounts", "write_discounts"],
  "core.returns": ["read_returns", "write_returns", "write_inventory"],
  "core.crm": ["read_customers"],
};
export const SHOPIFY_ALL_SCOPES = [...new Set(Object.values(SHOPIFY_SCOPES_BY_MODULE).flat())];
export const SHOPIFY_WEBHOOK_TOPICS = ["orders/create", "orders/updated", "orders/cancelled", "orders/paid", "orders/fulfilled", "products/create", "products/update", "products/delete", "inventory_levels/update", "fulfillments/create", "fulfillments/update", "refunds/create", "returns/request", "returns/approve", "returns/close", "customers/create", "customers/update", "app/uninstalled"];
export const SHOPIFY_API_VERSION = "2025-07";

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

export async function exchangeOAuthCode(shop: string, apiKey: string, apiSecret: string, code: string, fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }> = fetch as never): Promise<{ accessToken: string; scopes: string[] }> {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }) });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`Shopify token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { access_token: string; scope: string };
  return { accessToken: json.access_token, scopes: json.scope.split(",").map((s) => s.trim()).filter(Boolean) };
}

/** Values of Shopify's ReturnReason enum, chosen per return reason in Keel (empty = OTHER). */
export const SHOPIFY_RETURN_REASONS = ["COLOR", "DEFECTIVE", "NOT_AS_DESCRIBED", "OTHER", "SIZE_TOO_LARGE", "SIZE_TOO_SMALL", "STYLE", "UNKNOWN", "UNWANTED", "WRONG_ITEM"] as const;
