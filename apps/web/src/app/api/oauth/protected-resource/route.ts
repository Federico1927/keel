import { MCP_SCOPES, PRODUCT_NAME } from "@hullwise/config";
import { corsPreflight, mcpOrigin, mcpServerUrl, oauthJson } from "@/server/mcp";

export const dynamic = "force-dynamic";

/** RFC 9728 protected resource metadata of the MCP endpoint (served at /.well-known/oauth-protected-resource[/api/mcp]). */
export function GET() {
  return oauthJson({ resource: mcpServerUrl(), authorization_servers: [mcpOrigin()], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ["header"], resource_name: PRODUCT_NAME });
}
export function OPTIONS() {
  return corsPreflight();
}
