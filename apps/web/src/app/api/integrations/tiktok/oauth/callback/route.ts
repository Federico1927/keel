import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { appUrl, cookieDomain, isAdPlatformInPlan } from "@hullwise/config";
import { IntegrationError, TiktokAdsPlatform, classifySetupError, encryptJson, exchangeTiktokAuthCode, integrationMode } from "@hullwise/integrations";
import { recordAudit, schema } from "@hullwise/db";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import { requireAction } from "@/server/tenant";

/**
 * TikTok redirects here with `auth_code` and `state`: we check the state, exchange the code, verify the
 * advertisers and store encrypted credentials. A refusal or a failure goes back to the card as its
 * plain-words setup error (#90).
 */
export async function GET(req: NextRequest) {
  const authCode = req.nextUrl.searchParams.get("auth_code") ?? req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const jar = await cookies();
  const raw = jar.get("hullwise_tiktok_oauth")?.value;
  jar.delete({ name: "hullwise_tiktok_oauth", domain: cookieDomain(), path: "/" });
  const appId = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!raw || !appId || !appSecret || integrationMode() !== "live") return new NextResponse("oauth session missing", { status: 400 });
  const saved = JSON.parse(raw) as { state: string; slug: string };
  if (state !== saved.state) return new NextResponse("invalid oauth callback", { status: 401 });
  const back = (error: string) => NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?setup=tiktok&setup_error=${error}#provider-tiktok`, appUrl()));
  const denied = req.nextUrl.searchParams.get("error");
  if (denied || !authCode) return back(classifySetupError("tiktok", { code: denied ? "access_denied" : "token_expired", message: denied ?? "no auth code" }) ?? "unknown");
  const ctx = await requireAction(saved.slug, "manage_integrations", "integrations");
  if (!isAdPlatformInPlan("tiktok", ctx.tenant.planKey)) return new NextResponse("not found", { status: 404 });
  let token;
  try {
    token = await exchangeTiktokAuthCode({ appId, appSecret, authCode });
  } catch (e) {
    return back(classifySetupError("tiktok", { code: e instanceof IntegrationError ? e.code : null, message: e instanceof Error ? e.message : String(e) }) ?? "unknown");
  }
  if (!token.advertiserIds.length) return back("no_advertisers");
  const creds = { appId, appSecret, accessToken: token.accessToken, advertiserIds: token.advertiserIds };
  const test = await new TiktokAdsPlatform(creds).testConnection();
  if (!test.ok) return back(classifySetupError("tiktok", { code: test.errorCode ?? null, message: test.error ?? null }) ?? "unknown");
  await ctx.run(async (tx) => {
    const values = { status: "connected", mode: "live", externalAccountId: creds.advertiserIds.join(","), externalAccountName: test.accountName ?? creds.advertiserIds.join(","), credentialsEncrypted: encryptJson(creds), config: { advertiserIds: creds.advertiserIds, scopes: token.scope, installedVia: "oauth" }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "tiktok", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "tiktok", diff: { status: { from: null, to: "connected" }, advertisers: { from: null, to: creds.advertiserIds.length } } });
  });
  const until = new Date().toISOString().slice(0, 10);
  await enqueue("sync.ads", { tenantId: ctx.tenant.id, provider: "tiktok", since: new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10), until, kind: "backfill" }, { singletonKey: `${ctx.tenant.id}:tiktok:backfill:${until}` });
  return NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?connected=tiktok#provider-tiktok`, appUrl()));
}
