import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { apiEndpoint, appUrl, cookieDomain } from "@hullwise/config";
import { classifySetupError, googleOAuthAuthorizeUrl, integrationMode, mockGoogleAdsAccounts, newOAuthState, platformGoogleAdsApp, simulateSetupCheck } from "@hullwise/integrations";
import { savePendingGoogleSignIn } from "@/server/google-signin";
import { ForbiddenError, requireAction } from "@/server/tenant";

/**
 * "Sign in with Google" for Google Ads (#90): GET /api/integrations/google/oauth/start?tenant=<slug>.
 * Live: the platform's OAuth client (owner prerequisite) asks the merchant's consent for the adwords scope.
 * Mock: the simulated sign-in returns its accounts at once (`simulate=<outcome>` answers like Google
 * does on a refusal, MOCK_SETUP_TRIGGERS.google). Either way the card then shows the account picker.
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
  const back = (error?: string) => NextResponse.redirect(new URL(`/t/${slug}/integrations?setup=google${error ? `&setup_error=${error}` : ""}#provider-google`, appUrl()));
  if (integrationMode() !== "live") {
    const simulate = req.nextUrl.searchParams.get("simulate");
    const failure = simulate ? simulateSetupCheck("google", { oauth: simulate }) : null;
    if (failure) return back(classifySetupError("google", { code: failure.errorCode, message: failure.error }) ?? "unknown");
    await savePendingGoogleSignIn(ctx, { accounts: mockGoogleAdsAccounts(ctx.tenant.name, ctx.tenant.currency), tokenEncrypted: null, at: new Date().toISOString() });
    return back();
  }
  const app = platformGoogleAdsApp();
  if (!app) return back("app_not_configured");
  const state = newOAuthState();
  const jar = await cookies();
  jar.set("hullwise_google_oauth", JSON.stringify({ state, slug }), { domain: cookieDomain(), httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  return NextResponse.redirect(googleOAuthAuthorizeUrl({ clientId: app.clientId, redirectUri: apiEndpoint("/integrations/google/oauth/callback"), state }));
}
