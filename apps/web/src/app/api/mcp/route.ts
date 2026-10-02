import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkMcpRateLimit, createMcpServer, logMcpRequest, resolveMcpBearer } from "@keel/services";
import { MCP_TOOLS, corsPreflight, mcpDeps, mcpOrigin, protectedResourceMetadataUrl, withCors } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remote MCP endpoint (#21): Streamable HTTP, stateless (one server per request, JSON responses),
 * so any number of web instances can serve it. Order: bearer token → gates (plan, tenant switch,
 * kill switch, membership) → rate limits (fail closed) → the server for this principal.
 */

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return withCors(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), { status, headers: { "Content-Type": "application/json", ...headers } }));
}

const challenge = (error?: string, description?: string) => `Bearer resource_metadata="${protectedResourceMetadataUrl()}"${error ? `, error="${error}"` : ""}${description ? `, error_description="${description}"` : ""}`;

const DISABLED_MESSAGE: Record<string, string> = {
  plan: "MCP is not included in this workspace's plan (Growth and above).",
  tenant_disabled: "An owner or admin of this workspace has switched MCP off (Settings → AI & MCP).",
  killed: "MCP access to this workspace was suspended by the platform. Contact support.",
  platform_disabled: "MCP is temporarily unavailable.",
  suspended: "This workspace is suspended.",
};

export async function POST(req: Request) {
  const started = Date.now();
  const deps = mcpDeps();
  const header = req.headers.get("authorization");
  const raw = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  const auth = await resolveMcpBearer(deps, raw);
  if (!auth.ok) {
    if (auth.status === 401) {
      // a client without a token is discovering the authorization server: not a failure worth a row
      if (auth.code !== "missing_token") await logMcpRequest(deps, { tenantId: auth.tenantId ?? null, tokenId: auth.tokenId ?? null, userId: auth.userId ?? null, method: "auth", outcome: "auth_failed", errorCode: auth.code, durationMs: Date.now() - started });
      return jsonRpcError(401, -32001, auth.code === "missing_token" ? "Authentication required." : "Invalid or expired token.", { "WWW-Authenticate": challenge(auth.code === "missing_token" ? undefined : "invalid_token", auth.code === "missing_token" ? undefined : auth.code) });
    }
    await logMcpRequest(deps, { tenantId: auth.tenantId, tokenId: auth.tokenId, userId: auth.userId, clientName: auth.clientName, method: "auth", outcome: "disabled", errorCode: auth.code, durationMs: Date.now() - started });
    return jsonRpcError(403, -32003, DISABLED_MESSAGE[auth.code] ?? "MCP is not available.");
  }
  const p = auth.principal;
  const rate = await checkMcpRateLimit(deps, { tenantId: p.tenant.id, tokenId: p.tokenId });
  if (!rate.ok) {
    await logMcpRequest(deps, { tenantId: p.tenant.id, tokenId: p.tokenId, userId: p.userId, clientName: p.clientName, method: "rate_limit", outcome: "rate_limited", errorCode: rate.reason ?? null, durationMs: Date.now() - started });
    return jsonRpcError(429, -32029, rate.reason === "limiter_unavailable" ? "Rate limiter unavailable; retry shortly." : `Rate limit reached (${rate.reason === "token" ? "this connection" : "this workspace"}); retry in ${rate.retryAfter}s.`, { "Retry-After": String(rate.retryAfter) });
  }
  const server = createMcpServer({ deps, principal: p, tools: MCP_TOOLS, linkBase: mcpOrigin() });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    return withCors(res);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/** Stateless server: no standalone SSE stream and no session to delete. */
export async function GET() {
  return jsonRpcError(405, -32000, "Method not allowed: this server is stateless, use POST.", { Allow: "POST, OPTIONS" });
}
export async function DELETE() {
  return jsonRpcError(405, -32000, "Method not allowed: this server is stateless.", { Allow: "POST, OPTIONS" });
}
export function OPTIONS() {
  return corsPreflight();
}
