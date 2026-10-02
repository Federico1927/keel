import { z } from "zod";
import { canDo, canViewPage, canWritePage, isAddonModule, isPageEnabled, type ActionKey, type McpScope, type ModuleKey, type PageKey, type TenantRole } from "@hullwise/config";
import type { AssistantCitation } from "@hullwise/core";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "../analytics";

/**
 * The shared typed tool layer (#21). A tool is a typed function over the services, reached by the
 * in-app AI assistant and by the remote MCP server alike. Each tool declares what it touches (page,
 * action, module, scope) so both callers filter it the same way: role × page × action matrix,
 * modules of the tenant and, for MCP, the token's scopes. Tools never write SQL outside a service
 * module and always run inside the caller's tenant transaction (`rt.ctx`).
 */

export interface ToolTenant extends AnalyticsTenant {
  slug: string;
  name?: string;
  orderNumberPrefix?: string;
}

export interface ToolRuntime {
  ctx: ServiceContext;
  tenant: ToolTenant;
  slug: string;
  today: Date;
  userId: string;
  role: TenantRole;
  activeAddons: readonly string[];
  /** Prefix of the Hullwise links tools return: "" in the app (relative), the public origin for MCP clients. */
  linkBase?: string;
  /** Set when an AI client calls through MCP: recorded in the audit log and the order timeline. */
  mcp?: { tokenId: string; clientName: string };
}

export interface ToolResult {
  /** Compact data for the model: amounts in major units of the store currency, dates in the store time zone. */
  data: unknown;
  /** Figures, period, filters and the Hullwise page they come from (shown under assistant answers). */
  citation?: AssistantCitation;
}

export type ToolEffect = "read" | "write" | "proposal";

export interface HullwiseTool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Short human title (MCP clients show it in their tool list). */
  title?: string;
  description: string;
  /** The page the tool reads or writes: reads need view access, writes need write access or `action`. */
  page: PageKey;
  /** Writes and proposals: the permission matrix action the person needs (else write access to `page`). */
  action?: ActionKey;
  /** A module the tool needs beyond its page's own (e.g. an add-on). */
  module?: ModuleKey;
  /** The token scope that unlocks the tool through MCP. */
  scope: McpScope;
  effect: ToolEffect;
  /** Output keys that hold a person's name for this tool (masked with the other PII when masking is on). */
  piiNameKeys?: readonly string[];
  input: S;
  run(rt: ToolRuntime, input: z.infer<S>): Promise<ToolResult>;
}

/** A tool refused with a reason the model can act on (bad reference, wrong state). */
export class ToolError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolAccess {
  role: TenantRole;
  activeAddons: readonly string[];
  /** MCP: the token's scopes. The assistant passes none (read tools only). */
  scopes?: readonly McpScope[];
}

/** Why a tool is not available to a caller, or null when it is. */
export function toolDenial(t: HullwiseTool, a: ToolAccess): "module" | "role" | "scope" | null {
  if (!isPageEnabled(t.page, a.activeAddons)) return "module";
  if (t.module && isAddonModule(t.module) && !a.activeAddons.includes(t.module)) return "module";
  if (t.effect === "read") {
    if (!canViewPage(a.role, t.page)) return "role";
  } else if (t.action ? !canDo(a.role, t.action) : !canWritePage(a.role, t.page)) return "role";
  if (a.scopes ? !a.scopes.includes(t.scope) : t.effect !== "read") return "scope";
  return null;
}

export function toolAllowed(t: HullwiseTool, a: ToolAccess): boolean {
  return toolDenial(t, a) === null;
}

/** JSON Schema of a tool's input, as LLM APIs and MCP clients expect it. */
export function toolInputSchema(t: HullwiseTool): Record<string, unknown> {
  const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/* ---------- helpers shared by tools ---------- */

function fractionDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
/** Minor units to the decimal amount the model reads (and repeats) as money. */
export function majorUnits(minor: number | null | undefined, currency: string): number | null {
  if (minor === null || minor === undefined) return null;
  return Math.round(minor) / 10 ** fractionDigits(currency);
}
/** A decimal amount from a model to minor units of the currency (rounded). */
export function minorUnits(major: number, currency: string): number {
  return Math.round(major * 10 ** fractionDigits(currency));
}
export const roundTo = (v: number | null | undefined, digits = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
export const queryString = (p: Record<string, string | undefined>) => new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => !!e[1])).toString();

/** `YYYY-MM-DD HH:mm` in the store's time zone: what the model repeats to the person. */
export function localDateTime(d: Date | null | undefined, timeZone: string): string | null {
  if (!d) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
export function localDate(d: Date | null | undefined, timeZone: string): string | null {
  return localDateTime(d, timeZone)?.slice(0, 10) ?? null;
}

/** A link to a Hullwise page for the caller: relative in the app, absolute for MCP clients. */
export function hullwiseLink(rt: Pick<ToolRuntime, "linkBase" | "slug">, path: string): string {
  return `${rt.linkBase ?? ""}/t/${rt.slug}${path}`;
}
