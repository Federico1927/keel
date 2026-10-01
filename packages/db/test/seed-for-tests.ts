import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema";
import { seedDomain, type SeedContext } from "../src/seed";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** The real demo seed at a small scale, so every tenant table is covered by the isolation suite. */
export async function seedDomainForTests(db: Db, ctx: SeedContext): Promise<void> {
  await seedDomain(db, ctx, { scale: 0.01 });
}
