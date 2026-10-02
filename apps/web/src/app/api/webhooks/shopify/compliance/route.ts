import { NextResponse, type NextRequest } from "next/server";
import { adminDb } from "@hullwise/db";
import { handleShopifyCompliance } from "@hullwise/services";

function shopOf(rawBody: string): string {
  try {
    return String((JSON.parse(rawBody) as { shop_domain?: string }).shop_domain ?? "");
  } catch {
    return "";
  }
}

/**
 * Shopify's mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`), one
 * URL for the three topics, set on the app version in the Dev Dashboard. The HMAC is checked with the
 * secret of the app the store is connected through; 401 on a bad signature, as Shopify requires. What each
 * topic does: `handleShopifyCompliance` (packages/services) and docs/DECISIONS.md.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const shop = headers["x-shopify-shop-domain"] || shopOf(rawBody);
  if (!shop) return new NextResponse("missing shop domain", { status: 400 });
  const r = await handleShopifyCompliance(adminDb(), { topic: headers["x-shopify-topic"] ?? "", shop, rawBody, hmac: headers["x-shopify-hmac-sha256"], platformSecret: process.env.SHOPIFY_API_SECRET ?? null });
  return NextResponse.json({ ok: r.status === 200, action: r.action }, { status: r.status });
}
