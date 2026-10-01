/**
 * Post-deploy smoke check: `node scripts/smoke.mjs https://<host>` (or SMOKE_URL).
 * Checks the health endpoint and the public pages of the demo tenants; exits 1 on any failure.
 * Extra paths: SMOKE_PATHS="/r/my-store,/s/my-store".
 */
const base = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const paths = (process.env.SMOKE_PATHS ?? "/api/health,/login,/r/northwind-apparel,/r/harbor-home").split(",").filter(Boolean);
let failed = 0;
for (const path of paths) {
  try {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    const ok = res.status === 200;
    if (!ok) failed++;
    console.info(`${ok ? "ok  " : "FAIL"} ${res.status} ${path}`);
  } catch (e) {
    failed++;
    console.info(`FAIL ---  ${path} ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
