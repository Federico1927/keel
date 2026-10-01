/**
 * Creates the database roles and databases when Docker is not used
 * (system PostgreSQL). Idempotent. Needs a superuser connection in
 * DATABASE_SUPERUSER_URL (default postgres://postgres:postgres@127.0.0.1:5432/postgres).
 */
import { Client } from "pg";

const superUrl =
  process.env.DATABASE_SUPERUSER_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const databases = (process.env.KEEL_DATABASES ?? "keel,keel_test").split(",").map((s) => s.trim());

async function run() {
  const root = new Client({ connectionString: superUrl });
  await root.connect();
  await root.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keel_admin') THEN
      CREATE ROLE keel_admin LOGIN PASSWORD 'keel_admin' BYPASSRLS CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keel_app') THEN
      CREATE ROLE keel_app LOGIN PASSWORD 'keel_app' NOBYPASSRLS;
    END IF;
  END $$;`);
  for (const db of databases) {
    const exists = await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (exists.rowCount === 0) {
      await root.query(`CREATE DATABASE "${db}" OWNER keel_admin`);
      console.info(`[db:bootstrap] created database ${db}`);
    } else {
      await root.query(`ALTER DATABASE "${db}" OWNER TO keel_admin`);
    }
  }
  await root.end();

  const rootUrl = new URL(superUrl);
  for (const db of databases) {
    const url = new URL(rootUrl.toString());
    url.pathname = `/${db}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query(`
      ALTER SCHEMA public OWNER TO keel_admin;
      GRANT USAGE ON SCHEMA public TO keel_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keel_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO keel_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO keel_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO keel_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO keel_app;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    `);
    await c.end();
    console.info(`[db:bootstrap] prepared ${db}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
