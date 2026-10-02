import { adminDb, appDb } from "@keel/db";
import { MCP_CORE_TOOLS, appBaseUrl, ipHash, mcpResourceUrl, type KeelTool, type McpDeps } from "@keel/services";
import { COD_MCP_TOOLS } from "@keel/addon-cod";

/**
 * Web side of the MCP server (#21): connections to the databases, the tool list of this deployment
 * (core + add-ons; the server filters it per token) and the public URLs clients discover.
 */
export function mcpDeps(): McpDeps {
  return { admin: adminDb(), app: appDb() };
}

export const MCP_TOOLS: readonly KeelTool[] = [...MCP_CORE_TOOLS, ...COD_MCP_TOOLS];

export const mcpOrigin = () => appBaseUrl();
export const mcpServerUrl = () => mcpResourceUrl();
/** RFC 9728 metadata of the MCP endpoint (path-suffixed form; the bare form is served too). */
export const protectedResourceMetadataUrl = () => `${appBaseUrl()}/.well-known/oauth-protected-resource/api/mcp`;

/** Public, credential-less endpoints (metadata, registration, token, MCP itself) answer cross-origin calls: browser-based clients connect with only the URL. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Retry-After",
  "Access-Control-Max-Age": "86400",
};

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function clientIpHash(req: Request): string | null {
  return ipHash(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip"));
}

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...extra } }));
}

/** Reads form-encoded (the standard) or JSON token requests. */
export async function readOAuthBody(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}
