import { MCP_SCOPES } from "@keel/config";
import { corsPreflight, mcpOrigin, oauthJson } from "@/server/mcp";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata (served at /.well-known/oauth-authorization-server). */
export function GET() {
  const base = mcpOrigin();
  return oauthJson({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
  });
}
export function OPTIONS() {
  return corsPreflight();
}
