import { NextResponse, type NextRequest } from "next/server";
import { pixelTenantForKey } from "@hullwise/services";
import { browserScript, collectUrlFor } from "@/server/pixel-snippets";

/** The pixel script for a store, cached for an hour by browsers and CDNs. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const pixel = await pixelTenantForKey(key);
  if (!pixel || !pixel.enabled) return new NextResponse("// unknown pixel", { status: 404, headers: { "content-type": "application/javascript" } });
  return new NextResponse(browserScript(collectUrlFor(key)), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
