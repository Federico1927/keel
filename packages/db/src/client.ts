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

/**
 * The connection for `url`, or, when the variable is missing, a client whose every query fails
 * with "<name> is not set". Some modules create their handle at import time (e.g. the Auth.js adapter), and
 * `next build` imports them while collecting page data: the build must not need a database.
 */
function connect(name: string, url: string | undefined, max: number): Database {
  if (url) return drizzle(poolFor(url, max), { schema });
  // A real Drizzle instance (libraries such as the Auth.js adapter inspect it at import time)
  // over a pool that never opens a connection.
  const missing = () => Promise.reject(new Error(`${name} is not set`));
  const pool = new Pool();
  pool.connect = missing as Pool["connect"];
  pool.query = missing as Pool["query"];
  return drizzle(pool, { schema });
}

/** Application connection (role keel_app, RLS enforced). Use only through withTenant. */
export function appDb(url = process.env.DATABASE_URL): Database {
  return connect("DATABASE_URL", url, 10);
}

/** Administrative connection (role keel_admin, BYPASSRLS). Platform tables, super-admin, jobs. */
export function adminDb(url = process.env.DATABASE_ADMIN_URL): Database {
  return connect("DATABASE_ADMIN_URL", url, 5);
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
