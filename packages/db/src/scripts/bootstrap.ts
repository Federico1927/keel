/**
 * Creates the database roles and databases when Docker is not used
 * (system PostgreSQL). Idempotent. Needs a superuser connection in
 * DATABASE_SUPERUSER_URL (default: user postgres/postgres on the host and port of DATABASE_ADMIN_URL).
 */
import { Client } from "pg";
import { LEGACY_DB_ROLES, legacyEnvVars } from "@hullwise/config";

/** Superuser URL: explicit, else the compose superuser on the same host and port as DATABASE_ADMIN_URL. */
function defaultSuperUrl(): string {
  const u = new URL("postgres://postgres:postgres@127.0.0.1:5432/postgres");
  const admin = process.env.DATABASE_ADMIN_URL;
  if (admin) {
    try {
      const a = new URL(admin);
      u.hostname = a.hostname;
      u.port = a.port;
    } catch {
      /* keep the default */
    }
  }
  return u.toString();
}
const superUrl = process.env.DATABASE_SUPERUSER_URL || defaultSuperUrl();
const databases = (process.env.HULLWISE_DATABASES || "hullwise,hullwise_test").split(",").map((s) => s.trim());
/** Role passwords: dev defaults locally, set HULLWISE_ADMIN_PASSWORD / HULLWISE_APP_PASSWORD on any hosted database. */
const adminPassword = process.env.HULLWISE_ADMIN_PASSWORD || "hullwise_admin";
const appPassword = process.env.HULLWISE_APP_PASSWORD || "hullwise_app";
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** Refuses the configurations that would leave a hosted database unreachable after the rename (docs/DEPLOY.md, "Rename cutover"). */
function preflight() {
  const legacy = legacyEnvVars(process.env);
  if (legacy.length) {
    throw new Error(`[db:bootstrap] old-prefix variables found, rename them first: ${legacy.map((v) => `${v.legacy} → ${v.rename}`).join(", ")}`);
  }
  const host = new URL(superUrl).hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  // on a hosted database the default passwords would overwrite the real ones and lock the app out
  if (!local && (!process.env.HULLWISE_ADMIN_PASSWORD || !process.env.HULLWISE_APP_PASSWORD)) {
    throw new Error("[db:bootstrap] HULLWISE_ADMIN_PASSWORD and HULLWISE_APP_PASSWORD must be set on a hosted database.");
  }
}

/**
 * Pre-rename roles are renamed in place: grants, ownership and RLS policies follow the role, so the
 * existing data stays reachable. SCRAM passwords survive a rename; they are set again just below anyway.
 */
async function renameLegacyRoles(root: Client) {
  const pairs: [string, string][] = [
    [LEGACY_DB_ROLES.admin, "hullwise_admin"],
    [LEGACY_DB_ROLES.app, "hullwise_app"],
  ];
  for (const [from, to] of pairs) {
    const r = await root.query<{ old: boolean; new: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS old, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS new", [from, to]);
    const row = r.rows[0]!;
    if (row.old && !row.new) {
      await root.query(`ALTER ROLE ${ident(from)} RENAME TO ${ident(to)}`);
      console.info(`[db:bootstrap] renamed role ${from} to ${to}`);
    } else if (row.old && row.new) {
      console.warn(`[db:bootstrap] both ${from} and ${to} exist: ${from} was left untouched; drop it by hand once nothing uses it`);
    }
  }
}

async function run() {
  preflight();
  const root = new Client({ connectionString: superUrl });
  await root.connect();
  await renameLegacyRoles(root);
  await root.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hullwise_admin') THEN
      CREATE ROLE hullwise_admin LOGIN PASSWORD ${lit(adminPassword)} BYPASSRLS CREATEDB;
    ELSE
      ALTER ROLE hullwise_admin WITH LOGIN PASSWORD ${lit(adminPassword)} BYPASSRLS CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hullwise_app') THEN
      CREATE ROLE hullwise_app LOGIN PASSWORD ${lit(appPassword)} NOBYPASSRLS;
    ELSE
      ALTER ROLE hullwise_app WITH LOGIN PASSWORD ${lit(appPassword)} NOBYPASSRLS;
    END IF;
  END $$;`);
  for (const db of databases) {
    const exists = await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (exists.rowCount === 0) {
      await root.query(`CREATE DATABASE "${db}" OWNER hullwise_admin`);
      console.info(`[db:bootstrap] created database ${db}`);
    } else {
      await root.query(`ALTER DATABASE "${db}" OWNER TO hullwise_admin`);
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
      ALTER SCHEMA public OWNER TO hullwise_admin;
      GRANT USAGE ON SCHEMA public TO hullwise_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hullwise_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hullwise_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO hullwise_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hullwise_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hullwise_app;
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
