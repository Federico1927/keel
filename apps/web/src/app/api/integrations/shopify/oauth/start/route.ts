import { NextResponse, type NextRequest } from "next/server";
import { apiEndpoint, appUrl } from "@hullwise/config";
import { and, eq, schema } from "@hullwise/db";
import { SHOPIFY_ALL_SCOPES, buildInstallUrl, integrationMode, isValidShopDomain, signState } from "@hullwise/integrations";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { savedShopifyApp } from "@/server/shopify-connection";

/** Shopify OAuth state lifetime: the merchant approves within ten minutes. */
const STATE_TTL_SECONDS = 600;

/**
 * Authorization code grant (issue #89). GET /api/integrations/shopify/oauth/start?tenant=<slug>
 * - `app=tenant` (default, "Install on your store"): the merchant's own Dev Dashboard app saved by Connect
 *   (Client ID, shop, encrypted secret) when the client credentials grant is refused (store outside the
 *   app's organization);
 * - `app=public&shop=<x.myshopify.com>`: the platform app (`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`).
 * The `state` is signed (HMAC with APP_ENCRYPTION_KEY: tenant, user, shop, app, nonce, expiry), so the
 * callback resolves the tenant on its own, on whatever host it lands.
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("tenant") ?? "";
  const app = req.nextUrl.searchParams.get("app") === "public" ? "public" : "tenant";
  const back = (error: string) => NextResponse.redirect(new URL(`/t/${slug}/integrations?shopify_error=${error}`, appUrl()));
  let ctx;
  try {
    ctx = await requireAction(slug, "manage_integrations", "integrations");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  if (integrationMode() !== "live") return back("mock_mode");
  let shop: string;
  let clientId: string;
  if (app === "tenant") {
    const [row] = await ctx.run((tx) => tx.select({ config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "shopify"))).limit(1));
    const saved = savedShopifyApp(row?.config);
    if (!saved) return back("install_not_ready");
    shop = saved.shop;
    clientId = saved.clientId;
  } else {
    const apiKey = process.env.SHOPIFY_API_KEY;
    if (!apiKey || !process.env.SHOPIFY_API_SECRET) return new NextResponse("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not configured", { status: 501 });
    shop = (req.nextUrl.searchParams.get("shop") ?? "").trim().toLowerCase();
    clientId = apiKey;
  }
  if (!isValidShopDomain(shop)) return back("invalid_input");
  const state = signState({ t: ctx.tenant.id, s: slug, u: ctx.user.id, shop, app }, STATE_TTL_SECONDS);
  return NextResponse.redirect(buildInstallUrl(shop, clientId, SHOPIFY_ALL_SCOPES, apiEndpoint("/integrations/shopify/oauth/callback"), state));
}
