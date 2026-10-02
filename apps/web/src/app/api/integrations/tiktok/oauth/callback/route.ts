import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { isAdPlatformInPlan } from "@keel/config";
import { TiktokAdsPlatform, encryptJson, exchangeTiktokAuthCode, integrationMode } from "@keel/integrations";
import { recordAudit, schema } from "@keel/db";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import { requireAction } from "@/server/tenant";

/** TikTok redirects here with `auth_code` and `state`: we check the state, exchange the code, verify the advertisers and store encrypted credentials. */
export async function GET(req: NextRequest) {
  const authCode = req.nextUrl.searchParams.get("auth_code") ?? req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const jar = await cookies();
  const raw = jar.get("keel_tiktok_oauth")?.value;
  jar.delete("keel_tiktok_oauth");
  const appId = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!raw || !appId || !appSecret || integrationMode() !== "live") return new NextResponse("oauth session missing", { status: 400 });
  const saved = JSON.parse(raw) as { state: string; slug: string };
  if (!authCode || state !== saved.state) return new NextResponse("invalid oauth callback", { status: 401 });
  const ctx = await requireAction(saved.slug, "manage_integrations", "integrations");
  if (!isAdPlatformInPlan("tiktok", ctx.tenant.planKey)) return new NextResponse("not found", { status: 404 });
  const token = await exchangeTiktokAuthCode({ appId, appSecret, authCode });
  const creds = { appId, appSecret, accessToken: token.accessToken, advertiserIds: token.advertiserIds };
  const test = await new TiktokAdsPlatform(creds).testConnection();
  if (!test.ok) return NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?error=tiktok`, process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin));
  await ctx.run(async (tx) => {
    const values = { status: "connected", mode: "live", externalAccountId: creds.advertiserIds.join(","), externalAccountName: test.accountName ?? creds.advertiserIds.join(","), credentialsEncrypted: encryptJson(creds), config: { advertiserIds: creds.advertiserIds, scopes: token.scope, installedVia: "oauth" }, lastError: null, lastSuccessAt: new Date(), updatedAt: new Date() };
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "tiktok", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "tiktok", diff: { status: { from: null, to: "connected" }, advertisers: { from: null, to: creds.advertiserIds.length } } });
  });
  const until = new Date().toISOString().slice(0, 10);
  await enqueue("sync.ads", { tenantId: ctx.tenant.id, provider: "tiktok", since: new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10), until, kind: "backfill" }, { singletonKey: `${ctx.tenant.id}:tiktok:backfill:${until}` });
  return NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?connected=tiktok`, process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin));
}
