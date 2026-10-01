import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://keel_admin:keel_admin@127.0.0.1:5432/keel_test";
export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://keel_app:keel_app@127.0.0.1:5432/keel_test";

export function testPools() {
  const adminPool = new Pool({ connectionString: TEST_ADMIN_URL, max: 2 });
  const appPool = new Pool({ connectionString: TEST_APP_URL, max: 4 });
  return {
    admin: drizzle(adminPool, { schema }),
    app: drizzle(appPool, { schema }),
    async close() {
      await Promise.all([adminPool.end(), appPool.end()]);
    },
  };
}
