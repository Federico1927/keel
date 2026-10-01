import { sql } from "drizzle-orm";
import { appDb, type Database, type Transaction } from "./client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction whose `app.tenant_id` setting is fixed to the
 * tenant. Every RLS policy reads that setting. Domain queries must never run
 * outside this helper (CLAUDE.md §3).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Transaction) => Promise<T>,
  db: Database = appDb(),
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("withTenant: invalid tenant id");
  return db.transaction(async (tx) => {
    // set_config(..., true) is transaction-local: it disappears at COMMIT/ROLLBACK,
    // so a pooled connection never leaks the tenant to the next request.
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
