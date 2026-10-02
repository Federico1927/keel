import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { apiEndpoint, appUrl, cookieDomain, isAdPlatformInPlan } from "@hullwise/config";
import { classifySetupError, integrationMode, newOAuthState, simulateSetupCheck, tiktokAuthorizeUrl } from "@hullwise/integrations";
import { ForbiddenError, requireAction } from "@/server/tenant";

/**
 * "Connect TikTok": advertiser authorization with Hullwise's own TikTok for Business app (owner
 * prerequisite: TIKTOK_APP_ID / TIKTOK_APP_SECRET of an approved app). GET /api/integrations/tiktok/oauth/start?tenant=<slug>.
 * Mock mode: `simulate=<outcome>` answers like TikTok does on a refusal (MOCK_SETUP_TRIGGERS.tiktok); the
 * simulated account itself connects from the card.
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("tenant") ?? "";
  let ctx;
  try {
    ctx = await requireAction(slug, "manage_integrations", "integrations");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  if (!isAdPlatformInPlan("tiktok", ctx.tenant.planKey)) return new NextResponse("not found", { status: 404 });
  const back = (error: string) => NextResponse.redirect(new URL(`/t/${slug}/integrations?setup=tiktok&setup_error=${error}#provider-tiktok`, appUrl()));
  if (integrationMode() !== "live") {
    const simulate = req.nextUrl.searchParams.get("simulate");
    const failure = simulate ? simulateSetupCheck("tiktok", { oauth: simulate }) : null;
    if (failure) return back(classifySetupError("tiktok", { code: failure.errorCode, message: failure.error }) ?? "unknown");
    return new NextResponse("mock mode: connect the simulated account from the Integrations page", { status: 409 });
  }
  const appId = process.env.TIKTOK_APP_ID;
  if (!appId || !process.env.TIKTOK_APP_SECRET) return back("app_not_configured");
  const state = newOAuthState();
  const jar = await cookies();
  jar.set("hullwise_tiktok_oauth", JSON.stringify({ state, slug }), { domain: cookieDomain(), httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  const redirectUri = apiEndpoint("/integrations/tiktok/oauth/callback");
  return NextResponse.redirect(tiktokAuthorizeUrl(appId, redirectUri, state));
}
