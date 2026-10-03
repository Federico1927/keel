import { isPageEnabled } from "@hullwise/config";
import { and, eq, schema } from "@hullwise/db";
import { integrationMode } from "@hullwise/integrations";
import { campaignTick, type TenantRunner } from "@hullwise/services";
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

/** How a campaign channel delivers today: Spoki (its simulated account or the live one) or the simulated messaging channel. */
export type CampaignDelivery = "spoki_mock" | "spoki_live" | "simulated" | "external";

/**
 * Delivery of each channel for this store, shown on the campaign pages so nobody mistakes a demo send
 * for a real one: WhatsApp through Spoki when `addon.whatsapp_spoki` is on and connected (as the send
 * job decides), "sent from another tool" for the manual channel, the simulated channel otherwise.
 */
export async function campaignDeliveryFor(ctx: TenantContext): Promise<Record<string, CampaignDelivery>> {
  let whatsapp: CampaignDelivery = "simulated";
  if (ctx.activeAddons.includes("addon.whatsapp_spoki")) {
    const [row] = await ctx.run((tx) => tx.select({ status: schema.integrations.status, mode: schema.integrations.mode }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1));
    if (row && row.status !== "not_connected") whatsapp = integrationMode() === "live" && row.mode === "live" ? "spoki_live" : "spoki_mock";
  }
  return { email: "simulated", sms: "simulated", whatsapp, manual: "external" };
}
