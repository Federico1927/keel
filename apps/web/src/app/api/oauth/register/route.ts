import { OAuthError, registerOAuthClient } from "@keel/services";
import { clientIpHash, corsPreflight, mcpDeps, oauthJson } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7591 dynamic client registration: public clients (PKCE, no secret), rate limited per IP. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "Expected a JSON body." }, 400);
  }
  try {
    return oauthJson(await registerOAuthClient(mcpDeps(), body, clientIpHash(req)), 201);
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.error, error_description: e.description }, e.status);
    throw e;
  }
}
export function OPTIONS() {
  return corsPreflight();
}
