/** Drops and recreates the public schema of the target database, then migrates. */
import { Pool } from "pg";
import { runMigrations } from "../migrate";

const url: string | undefined = process.argv[2] ?? process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
const adminUrl: string = url;

async function run() {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  await pool.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE;
    CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO keel_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO keel_app;
    CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await pool.end();
  await runMigrations(adminUrl);
  console.info("[db:reset] done");
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
