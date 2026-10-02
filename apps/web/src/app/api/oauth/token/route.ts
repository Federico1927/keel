import { OAuthError, exchangeAuthorizationCode, refreshOAuthToken } from "@hullwise/services";
import { corsPreflight, mcpDeps, oauthJson, readOAuthBody } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Token endpoint: `authorization_code` (with PKCE) and `refresh_token` (rotating). */
export async function POST(req: Request) {
  const b = await readOAuthBody(req);
  try {
    const deps = mcpDeps();
    if (b.grant_type === "authorization_code") return oauthJson(await exchangeAuthorizationCode(deps, { code: b.code, codeVerifier: b.code_verifier, clientId: b.client_id, redirectUri: b.redirect_uri, resource: b.resource }));
    if (b.grant_type === "refresh_token") return oauthJson(await refreshOAuthToken(deps, { refreshToken: b.refresh_token, clientId: b.client_id, scope: b.scope }));
    return oauthJson({ error: "unsupported_grant_type", error_description: "authorization_code or refresh_token" }, 400);
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.error, error_description: e.description }, e.status);
    throw e;
  }
}
export function OPTIONS() {
  return corsPreflight();
}
