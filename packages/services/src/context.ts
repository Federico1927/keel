import type { Transaction } from "@hullwise/db";

/** What every service needs: the tenant transaction and who is acting. */
export interface ServiceContext {
  tenantId: string;
  tx: Transaction;
  /** `mcp`: an AI client acting for `userId` through the MCP server (#21). */
  actor: { type: "user" | "system" | "integration" | "mcp"; userId: string | null };
  now?: Date;
}
