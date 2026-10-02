import type { Transaction } from "@hullwise/db";

/** What every service needs: the tenant transaction and who is acting. */
export interface ServiceContext {
  tenantId: string;
  tx: Transaction;
  /** `mcp`: an AI client acting for `userId` through the MCP server (#21); `api`: a REST API token of `userId` (#81). */
  actor: { type: "user" | "system" | "integration" | "mcp" | "api"; userId: string | null };
  now?: Date;
}
