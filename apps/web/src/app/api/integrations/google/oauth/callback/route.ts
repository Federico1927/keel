import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { apiEndpoint, appUrl, cookieDomain } from "@hullwise/config";
import { IntegrationError, classifySetupError, encryptJson, exchangeGoogleOAuthCode, integrationMode, listGoogleAdsAccounts, platformGoogleAdsApp } from "@hullwise/integrations";
import { savePendingGoogleSignIn } from "@/server/google-signin";
import { ForbiddenError, requireAction } from "@/server/tenant";

/**
 * Google redirects here after the consent (#90): the state is checked, the code exchanged for a refresh
 * token, the reachable Google Ads accounts listed (manager accounts expanded), and the merchant sent back
 * to the card to pick one. A refusal or an error comes back as the card's plain-words setup error.
 */
export async function GET(req: NextRequest) {
  const jar = await cookies();
  const raw = jar.get("hullwise_google_oauth")?.value;
  jar.delete({ name: "hullwise_google_oauth", domain: cookieDomain(), path: "/" });
  const app = platformGoogleAdsApp();
  if (!raw || !app || integrationMode() !== "live") return new NextResponse("oauth session missing", { status: 400 });
  const saved = JSON.parse(raw) as { state: string; slug: string };
  const back = (error?: string) => NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?setup=google${error ? `&setup_error=${error}` : ""}#provider-google`, appUrl()));
  const q = req.nextUrl.searchParams;
  if (q.get("state") !== saved.state) return new NextResponse("invalid oauth callback", { status: 401 });
  if (q.get("error")) return back(classifySetupError("google", { message: q.get("error") }) ?? "unknown");
  let ctx;
  try {
    ctx = await requireAction(saved.slug, "manage_integrations", "integrations");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  try {
    const tokens = await exchangeGoogleOAuthCode({ clientId: app.clientId, clientSecret: app.clientSecret, code: q.get("code") ?? "", redirectUri: apiEndpoint("/integrations/google/oauth/callback") });
    const accounts = await listGoogleAdsAccounts({ accessToken: tokens.accessToken, developerToken: app.developerToken });
    await savePendingGoogleSignIn(ctx, { accounts, tokenEncrypted: encryptJson({ refreshToken: tokens.refreshToken }), at: new Date().toISOString() });
    return back();
  } catch (e) {
    return back(classifySetupError("google", { code: e instanceof IntegrationError ? e.code : null, message: e instanceof Error ? e.message : String(e) }) ?? "unknown");
  }
}
