import { Pool } from "pg";
import { runMigrations } from "../src/migrate";
import { TEST_ADMIN_URL } from "../src/test-utils";

/** Fresh schema on the test database before the suite runs. */
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
