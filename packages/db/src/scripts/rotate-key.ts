import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { formatRotationReport, rotateEncryptionKey } from "../rotate-key";

/**
 * `pnpm db:rotate-key [--dry-run]`: re-encrypts every stored secret with APP_ENCRYPTION_KEY, reading
 * the old ones with APP_ENCRYPTION_KEY_PREVIOUS (docs/DEPLOY.md, "Rotating secrets"). Without the
 * previous key it only verifies that everything opens with the current one. Exit code 1 when a
 * payload opens with neither key.
 */
async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  const dryRun = process.argv.includes("--dry-run");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const report = await rotateEncryptionKey(drizzle(pool, { schema }), { dryRun });
    console.info(formatRotationReport(report));
    if (report.unreadable) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
