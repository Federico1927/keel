import { isPageEnabled } from "@keel/config";
import { campaignTick, type TenantRunner } from "@keel/services";
import { enqueue, runJobInline } from "./jobs";
import type { TenantContext } from "./tenant";

/**
 * Customer campaigns without waiting for the next worker tick (#34): due campaigns start, sequences
 * enrol, and every delivering campaign gets its send job: queued for the worker when one is
 * deployed, run here otherwise (a single-process demo sends on page loads, like the queue pages
 * sync). Call it inside `after()`. The send window, the throttle and the idempotency keys apply
 * exactly as in the worker.
 */
export async function kickCampaigns(ctx: TenantContext): Promise<void> {
  if (!isPageEnabled("customer_campaigns", ctx.activeAddons)) return;
  const run: TenantRunner = (fn) => ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "system", userId: null } }));
  try {
    const r = await campaignTick(run, { id: ctx.tenant.id, timezone: ctx.tenant.timezone, settings: ctx.settings });
    for (const campaignId of r.delivering) {
      const job = { tenantId: ctx.tenant.id, campaignId };
      if (!(await enqueue("campaign.send", job, { singletonKey: `campaign:${campaignId}` }))) await runJobInline("campaign.send", job, null);
    }
  } catch (e) {
    console.error("[web] campaign kick failed:", e instanceof Error ? e.message : e);
  }
}
