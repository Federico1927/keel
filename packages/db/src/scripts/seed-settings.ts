import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { ensureDemoSettings } from "../seed/settings";
import { ensurePlatformOwner } from "../seed/platform-owner";

/**
 * Fills in the demo tenants' missing configuration rows (`pnpm db:seed:settings`). Run by
 * `db:deploy` on every deploy: never touches orders or any row that already exists.
 */
async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  const pool = new Pool({ connectionString: url });
  try {
    const report = await ensureDemoSettings(drizzle(pool, { schema }));
    if (!report.length) console.info("[db:seed:settings] no demo tenant: nothing to do");
    for (const r of report) console.info(`[db:seed:settings] ${r.tenant}: ${r.created.length ? `created ${r.created.join(", ")}` : "up to date"}`);
    const owner = await ensurePlatformOwner(drizzle(pool, { schema }));
    if (owner.owner === "missing_password") console.warn("[db:seed:settings] HULLWISE_OWNER_EMAIL is set but the account does not exist yet and HULLWISE_OWNER_PASSWORD is missing or shorter than 12 characters");
    else if (owner.owner !== "not_configured") console.info(`[db:seed:settings] platform owner: ${owner.owner}`);
    if (owner.demoted.length) console.info(`[db:seed:settings] demo super-admins removed from the console: ${owner.demoted.join(", ")}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
