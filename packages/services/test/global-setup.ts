import { Pool } from "pg";
import { runMigrations } from "@keel/db";
import { TEST_ADMIN_URL } from "@keel/db/test-utils";

/** Same fresh-schema setup as packages/db; turbo serialises the two suites via `^test`. */
export default async function setup() {
  const pool = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  await pool.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO keel_app;
    CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await pool.end();
  await runMigrations(TEST_ADMIN_URL);
}
