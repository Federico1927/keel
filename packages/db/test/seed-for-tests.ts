import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema";
import type { SeedContext } from "../src/seed";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Domain rows for the isolation suite. Until the full demo seed exists (phase 2),
 * this inserts a minimal row per tenant table for both tenants. From phase 2 on it
 * delegates to the real seed so every table is covered automatically.
 */
export async function seedDomainForTests(db: Db, ctx: SeedContext): Promise<void> {
  for (const tenantId of Object.values(ctx.tenantIds)) {
    await db.insert(schema.auditLogs).values({ tenantId, action: "test.seed", actorType: "system" });
  }
}
