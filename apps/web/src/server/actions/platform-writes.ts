"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canDo, canWritePage, isPageEnabled, type PageKey } from "@hullwise/config";
import { recordAudit } from "@hullwise/db";
import { getPlatformWrite, retryPlatformWrite, runCatalogSync, getCommercePlatformFor } from "@hullwise/services";
import { enqueue } from "@/server/jobs";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, getTenantContext, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/** The page whose write permission covers a write; integration managers may retry any. */
function pageFor(kind: string, entityType: string): PageKey {
  if (kind.startsWith("inventory.")) return "inventory";
  if (kind.startsWith("return.")) return "returns";
  if (kind.startsWith("discount.")) return "discounts";
  if (kind.startsWith("campaign.")) return "campaigns";
  if (kind.startsWith("order.")) return "orders";
  return entityType === "variant" || entityType === "product" ? "products" : "integrations";
}

/** Manual retry of a failed (or waiting) outbox write: back in line now, then dispatched like a fresh one. */
export async function retryPlatformWriteAction(slug: string, writeId: string): Promise<ActionResult<{ status: string }>> {
  try {
    if (!z.string().uuid().safeParse(writeId).success) return fail("invalid_input");
    const ctx = await getTenantContext(slug);
    const svc = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
    const current = await ctx.run((tx) => getPlatformWrite(svc(tx), writeId));
    if (!current) return fail("not_found");
    const page = pageFor(current.kind, current.entityType);
    const allowed = canDo(ctx.role, "manage_integrations") || (isPageEnabled(page, ctx.activeAddons) && canWritePage(ctx.role, page) && (page !== "campaigns" || canDo(ctx.role, "pause_campaign")));
    if (!allowed) return fail("forbidden");
    const row = await ctx.run(async (tx) => {
      const r = await retryPlatformWrite(svc(tx), writeId);
      if (r) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "platform_write.retried", entityType: current.entityType, entityId: current.entityId ?? undefined, diff: { status: { from: current.status, to: r.status } }, metadata: { writeId, kind: current.kind, attempts: current.attempts } });
      return r;
    });
    if (!row) return fail("invalid_input");
    await dispatchPlatformWrites(ctx, [row]);
    const after = await ctx.run((tx) => getPlatformWrite(svc(tx), writeId));
    revalidatePath(`/t/${slug}`, "layout");
    return ok({ status: after?.status ?? row.status });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** "Sync now" on the inventory page: re-reads stock for every variant (queued with a worker, inline otherwise). */
export async function syncInventoryNow(slug: string): Promise<ActionResult<{ queued: boolean; scanned: number; changed: number; drift: number; conflicts: number; zeroed: number; finished: boolean }>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "inventory.sync_requested", entityType: "integration", entityId: "shopify" }));
    if (await enqueue("sync.catalog", { tenantId: ctx.tenant.id, kind: "manual", scope: "inventory" }, { singletonKey: `${ctx.tenant.id}:catalog:inventory` })) return ok({ queued: true, scanned: 0, changed: 0, drift: 0, conflicts: 0, zeroed: 0, finished: false });
    const r = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      return runCatalogSync(s, await getCommercePlatformFor(s, ctx.tenant), { kind: "manual", scope: "inventory", budgetMs: 20_000 });
    });
    if (r.error) return fail("platform_error", { platform: r.error });
    revalidatePath(`/t/${slug}/inventory`);
    revalidatePath(`/t/${slug}/integrations`);
    return ok({ queued: false, scanned: r.inventory, changed: r.inventory, drift: r.drift, conflicts: r.conflicts, zeroed: r.zeroed, finished: r.finished });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
