import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { SHOPIFY_ALL_SCOPES, buildInstallUrl, isValidShopDomain, newOAuthState } from "@keel/integrations";
import { requireAction } from "@/server/tenant";

/** Public-app OAuth: GET /api/integrations/shopify/oauth/start?tenant=<slug>&shop=<x.myshopify.com> */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("tenant") ?? "";
  const shop = (req.nextUrl.searchParams.get("shop") ?? "").toLowerCase();
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey || !process.env.SHOPIFY_API_SECRET) return new NextResponse("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not configured", { status: 501 });
  if (!isValidShopDomain(shop)) return new NextResponse("invalid shop domain", { status: 400 });
  await requireAction(slug, "manage_integrations", "integrations");
  const state = newOAuthState();
  const jar = await cookies();
  jar.set("keel_shopify_oauth", JSON.stringify({ state, slug, shop }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/api/integrations/shopify/oauth/callback`;
  return NextResponse.redirect(buildInstallUrl(shop, apiKey, SHOPIFY_ALL_SCOPES, redirectUri, state));
}
