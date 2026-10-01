import { PgBoss } from "pg-boss";

/** pg-boss uses the administrative connection: its own schema is not tenant data. */
export function createBoss(connectionString = process.env.DATABASE_ADMIN_URL): PgBoss {
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL is required for the job runner");
  return new PgBoss({ connectionString, schema: "pgboss" });
}
