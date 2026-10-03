import { NextResponse, type NextRequest } from "next/server";
import { apiEndpoint, appUrl } from "@hullwise/config";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { SHOPIFY_WEBHOOK_TOPICS, ShopifyCommercePlatform, ShopifyGrantError, decryptJson, exchangeOAuthCode, verifyOAuthCallback, verifyState, type ShopifyCredentials } from "@hullwise/integrations";
import { recordShopifyWebhooks, savedShopifyApp, saveShopifyConnection } from "@/server/shopify-connection";
import { startHistoryImport } from "@/server/history-import";
import { requireAction } from "@/server/tenant";

interface ShopifyState extends Record<string, unknown> {
  t: string;
  s: string;
  u: string;
  shop: string;
  app: "tenant" | "public";
}

/**
 * Shopify redirects here with code/hmac/shop/state (issue #89). The signed `state` names the tenant; the
 * query HMAC is verified with that tenant's app secret (or the platform app's), the code is exchanged for
 * the offline token (stored encrypted, with its expiry and refresh token when Shopify sends them), webhooks
 * are registered and the history import starts. Errors go back to the integrations page as a code the card
 * explains in plain words.
 */
export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams.entries());
  const st = verifyState<ShopifyState>(q.state);
  if (!st || q.shop !== st.shop) return new NextResponse("invalid or expired oauth state", { status: 401 });
  const back = (query: string) => NextResponse.redirect(new URL(`/t/${st.s}/integrations?${query}`, appUrl()));
  const tenant = await withTenant(st.t, async (tx) => {
    const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, st.t)).limit(1);
    const [row] = await tx.select({ config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, st.t), eq(schema.integrations.provider, "shopify"))).limit(1);
    return t ? { ...t, app: savedShopifyApp(row?.config) } : null;
  });
  if (!tenant) return new NextResponse("unknown tenant", { status: 404 });
  let clientId: string;
  let secret: string;
  if (st.app === "tenant") {
    if (!tenant.app || tenant.app.shop !== st.shop) return back("shopify_error=install_not_ready");
    clientId = tenant.app.clientId;
    secret = decryptJson<{ clientSecret: string }>(tenant.app.secretEncrypted).clientSecret;
  } else {
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) return new NextResponse("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not configured", { status: 501 });
    clientId = process.env.SHOPIFY_API_KEY;
    secret = process.env.SHOPIFY_API_SECRET;
  }
  if (!verifyOAuthCallback(q, secret)) return back("shopify_error=wrong_credentials");
  let credentials: ShopifyCredentials;
  try {
    const token = await exchangeOAuthCode(st.shop, clientId, secret, q.code ?? "");
    credentials = { shop: st.shop, clientId, apiSecret: secret, accessToken: token.accessToken, expiresAt: token.expiresAt, refreshToken: token.refreshToken ?? null, grant: "authorization_code" };
  } catch (e) {
    return back(`shopify_error=${e instanceof ShopifyGrantError ? e.reason : "unknown"}`);
  }
  const platform = new ShopifyCommercePlatform(credentials);
  const test = await platform.testConnection();
  if (!test.ok) return back("shopify_error=unknown");
  await saveShopifyConnection(tenant.id, { actorUserId: st.u, actorType: "user" }, { mode: "live", shop: st.shop, name: test.accountName ?? st.shop, credentials, test, config: { installedVia: st.app === "tenant" ? "oauth_own_app" : "oauth_public_app", webhooks: [] } });
  await recordShopifyWebhooks(tenant.id, await platform.registerWebhooks(apiEndpoint("/webhooks/shopify"), SHOPIFY_WEBHOOK_TOPICS).catch(() => []));
  // the store's order history (#87) needs the installer's session; without it the connection stays saved and "Resync" starts it
  await requireAction(st.s, "manage_integrations", "integrations").then((ctx) => startHistoryImport(ctx)).catch((e: unknown) => console.error("[web] history import not started:", e instanceof Error ? e.message : e));
  return back(`connected=shopify${test.missingRequiredScopes?.length ? "&shopify_error=missing_scopes" : ""}`);
}
