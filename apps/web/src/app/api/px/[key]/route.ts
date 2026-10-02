import { NextResponse, type NextRequest } from "next/server";
import { withTenant } from "@hullwise/db";
import { pixelBatchSchema } from "@hullwise/core";
import { ingestPixelBatch, originAllowed, PixelError, pixelTenantForKey } from "@hullwise/services";

/**
 * Public collect endpoint of the first-party pixel. Accepts text/plain JSON (sendBeacon, no CORS
 * preflight), answers 204, never reveals whether a key exists beyond a 404, and rate-limits per
 * hashed IP inside the tenant.
 */
function cors(origin: string | null) {
  return { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  const pixel = await pixelTenantForKey(key);
  if (!pixel || !pixel.enabled) return new NextResponse(null, { status: 404, headers });
  if (!originAllowed(pixel.allowedOrigins, origin)) return new NextResponse(null, { status: 403, headers });
  const raw = await req.text();
  if (raw.length > 64_000) return new NextResponse(null, { status: 413, headers });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400, headers });
  }
  const parsed = pixelBatchSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400, headers });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || null;
  try {
    await withTenant(pixel.tenantId, (tx) => ingestPixelBatch({ tenantId: pixel.tenantId, tx, actor: { type: "integration", userId: null } }, parsed.data.events, { ip, userAgent: req.headers.get("user-agent") }));
  } catch (e) {
    if (e instanceof PixelError && e.code === "rate_limited") return new NextResponse(null, { status: 429, headers: { ...headers, "retry-after": "600" } });
    throw e;
  }
  return new NextResponse(null, { status: 204, headers });
}
