import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Either a database or a transaction: services accept both. */
export type DbExecutor = Database | Transaction;

const pools = new Map<string, Pool>();

function poolFor(url: string, max: number): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max });
    pool.on("error", (err) => console.error("[db] pool error", err));
    pools.set(url, pool);
  }
  return pool;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Application connection (role keel_app, RLS enforced). Use only through withTenant. */
export function appDb(url = required("DATABASE_URL")): Database {
  return drizzle(poolFor(url, 10), { schema });
}

/** Administrative connection (role keel_admin, BYPASSRLS). Platform tables, super-admin, jobs. */
export function adminDb(url = required("DATABASE_ADMIN_URL")): Database {
  return drizzle(poolFor(url, 5), { schema });
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
