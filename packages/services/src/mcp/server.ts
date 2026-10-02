import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { withTenant } from "@hullwise/db";
import { PRODUCT_NAME } from "@hullwise/config";
import { AssistantInputError, maskPii } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { ToolError, toolDenial, toolInputSchema, type HullwiseTool, type ToolRuntime } from "../tools";
import { touchMcpToken, type McpDeps, type McpPrincipal } from "./auth";
import { logMcpRequest, type McpOutcome } from "./limits";

/**
 * The MCP server for one authenticated principal (#21), built per request (stateless Streamable
 * HTTP). It lists only the tools the principal may call (scopes × role × page × action × modules)
 * and runs every call inside `withTenant` as the connected person, with actor type `mcp`. Output is
 * PII-masked unless the tenant enabled full PII for MCP and the role may see it. Every call is
 * logged (tool, user, client, duration, outcome), never with its arguments or results.
 *
 * It uses the SDK's low-level `Server` on purpose: the tool list depends on the token, the input is
 * validated with the tools' own zod schemas, and refused calls must be logged with their reason.
 */

export interface McpServerOptions {
  deps: McpDeps;
  principal: McpPrincipal;
  /** Every tool the deployment knows (core + add-ons); the server filters them for the principal. */
  tools: readonly HullwiseTool[];
  /** Public origin for links in tool results (`https://app.example.com`). */
  linkBase: string;
  version?: string;
}

function toolDescriptor(t: HullwiseTool): Tool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: toolInputSchema(t) as Tool["inputSchema"],
    annotations: { title: t.title, readOnlyHint: t.effect === "read", destructiveHint: false, idempotentHint: t.effect === "read", openWorldHint: false },
  };
}

function instructions(p: McpPrincipal): string {
  const t = p.tenant;
  return [
    `${PRODUCT_NAME} is the operations platform of the online store "${t.name}". You act as one team member (role: ${p.role}) and only see what that role may see.`,
    `Amounts are in ${t.currency} (major units) unless a row says otherwise; dates are in the store's time zone ${t.timezone}. Each result links to the Hullwise page it comes from.`,
    p.pii === "masked" ? "Customer names, emails, phones and addresses are masked (m***@domain, •••1234)." : "Customer details are shown in full: handle them as personal data.",
    "Write tools only make reversible changes (internal notes, assignees, review or hold statuses). Cancelling, refunding, pausing campaigns and purchase orders are proposals that a person approves in Hullwise: say so to the user, never claim they are done.",
  ].join("\n");
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createMcpServer(opts: McpServerOptions): Server {
  const { deps, principal } = opts;
  const access = { role: principal.role, activeAddons: principal.activeAddons, scopes: principal.scopes };
  const listed = opts.tools.filter((t) => toolDenial(t, access) === null);
  const base = { tenantId: principal.tenant.id, tokenId: principal.tokenId, userId: principal.userId, clientName: principal.clientName };
  const server = new Server({ name: "hullwise", title: PRODUCT_NAME, version: opts.version ?? "1.0.0" }, { capabilities: { tools: { listChanged: false } }, instructions: instructions(principal) });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await logMcpRequest(deps, { ...base, method: "tools/list", outcome: "ok" });
    return { tools: listed.map(toolDescriptor) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const name = req.params.name;
    const done = async (outcome: McpOutcome, errorCode: string | null, result: CallToolResult) => {
      await logMcpRequest(deps, { ...base, method: "tools/call", tool: name, outcome, errorCode, durationMs: Date.now() - started });
      return result;
    };
    const tool = opts.tools.find((t) => t.name === name);
    if (!tool) return done("not_found", "unknown_tool", errorResult(`Unknown tool "${name.slice(0, 80)}". Call tools/list for the tools available to this connection.`));
    const denial = toolDenial(tool, access);
    if (denial === "scope") return done("denied", `missing_scope:${tool.scope}`, errorResult(`This connection was not granted the "${tool.scope}" scope. Reconnect and allow it, or ask the user to create a token with it.`));
    if (denial === "role") return done("denied", "role", errorResult(`The user's role (${principal.role}) does not allow ${tool.effect === "read" ? "reading" : "changing"} this in Hullwise.`));
    if (denial === "module") return done("denied", "module", errorResult("This feature is not active for this store."));
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return done("invalid_input", "schema", errorResult(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ").slice(0, 500)}`));
    try {
      const now = deps.now?.() ?? new Date();
      const out = await withTenant(
        principal.tenant.id,
        async (tx) => {
          const ctx: ServiceContext = { tenantId: principal.tenant.id, tx, actor: { type: "mcp", userId: principal.userId }, now: deps.now?.() };
          await touchMcpToken(ctx, principal);
          const rt: ToolRuntime = { ctx, tenant: principal.tenant, slug: principal.tenant.slug, today: now, userId: principal.userId, role: principal.role, activeAddons: principal.activeAddons, linkBase: opts.linkBase, mcp: { tokenId: principal.tokenId, clientName: principal.clientName } };
          return tool.run(rt, parsed.data);
        },
        deps.app,
      );
      const c = out.citation;
      const data = c ? { ...(out.data as Record<string, unknown>), source: { period: c.period, filters: c.filters, link: `${opts.linkBase}${c.href}` } } : out.data;
      const safe = principal.pii === "masked" ? maskPii(data, { nameKeys: tool.piiNameKeys }) : data;
      return done("ok", null, { content: [{ type: "text", text: JSON.stringify(safe) }] });
    } catch (err) {
      if (err instanceof ToolError) return done(err.code === "not_found" ? "not_found" : err.code === "forbidden" ? "denied" : "invalid_input", err.code, errorResult(err.message));
      if (err instanceof AssistantInputError) return done("invalid_input", "period", errorResult(`Invalid input: ${err.message}`));
      console.error(`[mcp] tool ${name} failed`, err);
      return done("error", "server_error", errorResult("The tool failed on the server. Tell the user this data is unavailable right now."));
    }
  });
  return server;
}
