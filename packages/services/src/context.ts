import type { Transaction } from "@keel/db";

/** What every service needs: the tenant transaction and who is acting. */
export interface ServiceContext {
  tenantId: string;
  tx: Transaction;
  actor: { type: "user" | "system" | "integration"; userId: string | null };
  now?: Date;
}
