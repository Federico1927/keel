import { adminDb } from "@hullwise/db";
import { billingSettings, syncBillingCatalog } from "@hullwise/services";

/**
 * `pnpm billing:sync-catalog` (#53): creates or updates the Stripe product and price of every plan,
 * setup fee and add-on in @hullwise/config (same as the console button). Idempotent; with no
 * STRIPE_SECRET_KEY it fills the mock catalog. Prints counts only, never the key.
 */
async function main() {
  const s = billingSettings();
  const r = await syncBillingCatalog(adminDb(), { actorUserId: null });
  console.info(`[billing] catalog synced (${s.provider}, ${s.mode}): ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.archived} prices archived`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[billing] catalog sync failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
