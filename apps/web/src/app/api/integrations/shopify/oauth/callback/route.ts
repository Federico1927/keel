import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { appUrl, cookieDomain } from "@hullwise/config";
import { encryptJson, exchangeOAuthCode, verifyOAuthCallback } from "@hullwise/integrations";
import { recordAudit, schema } from "@hullwise/db";
import { requireAction } from "@/server/tenant";

/** Shopify redirects here with code/hmac/shop/state; we verify, exchange the code and store encrypted credentials. */
export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams.entries());
  const jar = await cookies();
  const raw = jar.get("hullwise_shopify_oauth")?.value;
  jar.delete({ name: "hullwise_shopify_oauth", domain: cookieDomain(), path: "/" });
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!raw || !apiKey || !apiSecret) return new NextResponse("oauth session missing", { status: 400 });
  const saved = JSON.parse(raw) as { state: string; slug: string; shop: string };
  if (q.state !== saved.state || q.shop !== saved.shop || !verifyOAuthCallback(q, apiSecret)) return new NextResponse("invalid oauth callback", { status: 401 });
  const ctx = await requireAction(saved.slug, "manage_integrations", "integrations");
  const { accessToken, scopes } = await exchangeOAuthCode(saved.shop, apiKey, apiSecret, q.code ?? "");
  await ctx.run(async (tx) => {
    const values = { status: "connected", mode: "live", externalAccountId: saved.shop, externalAccountName: saved.shop, credentialsEncrypted: encryptJson({ shop: saved.shop, accessToken, apiSecret }), config: { scopes, installedVia: "oauth" }, lastError: null, updatedAt: new Date() };
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "shopify", ...values }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: values });
    await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "integration.connected", entityType: "integration", entityId: "shopify", diff: { status: { from: null, to: "connected" }, shop: { from: null, to: saved.shop } } });
  });
  return NextResponse.redirect(new URL(`/t/${saved.slug}/integrations?connected=shopify`, appUrl()));
}
