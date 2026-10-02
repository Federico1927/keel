import { ASSISTANT_TOOLS } from "../assistant/tools";
import type { HullwiseTool } from "../tools";
import { MCP_READ_TOOLS } from "./read-tools";
import { MCP_WRITE_TOOLS } from "./write-tools";

export * from "./auth";
export * from "./crypto";
export * from "./limits";
export * from "./pending";
export * from "./server";
export * from "./admin";
export { MCP_READ_TOOLS, resolveOrderRef } from "./read-tools";
export { MCP_WRITE_TOOLS } from "./write-tools";

/**
 * Every core tool of the MCP server: the assistant's analytics tools (KPIs, P/L, products,
 * campaigns, returns, predictions, stock to reorder), the MCP read tools and the write tools.
 * Add-on packages export their own (e.g. `COD_MCP_TOOLS`) and the web app adds them to this list.
 */
export const MCP_CORE_TOOLS: readonly HullwiseTool[] = [...ASSISTANT_TOOLS, ...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS];
