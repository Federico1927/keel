import { parsePlaceholderPath, placeholderProductSvg } from "@hullwise/ui/placeholder-image";

/**
 * Demo product photos (issue #19): `/demo-media/<handle>/<n>-<label>.svg`, drawn on the fly and
 * cached for a year (the same path always gives the same image). Public like any product image:
 * the middleware skips `.svg` paths.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const input = parsePlaceholderPath((await params).path);
  if (!input) return new Response("Not found", { status: 404 });
  return new Response(placeholderProductSvg(input), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
