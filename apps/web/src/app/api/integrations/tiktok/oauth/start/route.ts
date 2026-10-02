import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { isAdPlatformInPlan } from "@keel/config";
import { integrationMode, newOAuthState, tiktokAuthorizeUrl } from "@keel/integrations";
import { requireAction } from "@/server/tenant";

/** Advertiser authorization with Keel's own TikTok for Business app: GET /api/integrations/tiktok/oauth/start?tenant=<slug> */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("tenant") ?? "";
  const appId = process.env.TIKTOK_APP_ID;
  if (!appId || !process.env.TIKTOK_APP_SECRET) return new NextResponse("TIKTOK_APP_ID / TIKTOK_APP_SECRET are not configured", { status: 501 });
  if (integrationMode() !== "live") return new NextResponse("mock mode: connect the simulated account from the Integrations page", { status: 409 });
  const ctx = await requireAction(slug, "manage_integrations", "integrations");
  if (!isAdPlatformInPlan("tiktok", ctx.tenant.planKey)) return new NextResponse("not found", { status: 404 });
  const state = newOAuthState();
  const jar = await cookies();
  jar.set("keel_tiktok_oauth", JSON.stringify({ state, slug }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/api/integrations/tiktok/oauth/callback`;
  return NextResponse.redirect(tiktokAuthorizeUrl(appId, redirectUri, state));
}
