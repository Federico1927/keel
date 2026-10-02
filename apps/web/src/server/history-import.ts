import { historyImportSince } from "@hullwise/core";
import { recordAudit } from "@hullwise/db";
import { getCommercePlatformFor, historyImportStatus, runCatalogSync, runOrdersSync, runReturnsSync } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import type { TenantContext } from "@/server/tenant";

export type HistoryImportStart = "already_done" | "queued" | "inline_finished" | "inline_paused" | "inline_error";

/**
 * Starts (or resumes) the first Shopify import of a store, issue #87: every order inside the
 * tenant's history window, then the catalog and the returns of those orders. On the worker it
 * runs as resumable jobs (the orders job queues the returns import when it finishes); without
 * the queue one time budget runs inline and "Resync" continues it. A finished import is never
 * started again.
 */
export async function startHistoryImport(ctx: TenantContext, opts: { inlineBudgetMs?: number } = {}): Promise<HistoryImportStart> {
  const status = await ctx.run((tx) => historyImportStatus({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  if (status.state === "done") return "already_done";
  await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.history_import_requested", entityType: "integration", entityId: "shopify", diff: { historyImportMonths: { from: null, to: ctx.settings.historyImportMonths }, state: { from: null, to: status.state } } }));
  const tenantId = ctx.tenant.id;
  // singleton keys match the ones the job handlers use when a paused run re-enqueues itself
  const queued = await enqueue("sync.orders", { tenantId, kind: "initial" }, { singletonKey: `${tenantId}:initial` });
  if (queued) {
    await enqueue("sync.catalog", { tenantId, kind: "delta" }, { singletonKey: `${tenantId}:catalog:catalog` });
    return "queued";
  }
  const since = historyImportSince(new Date(), ctx.settings.historyImportMonths);
  return ctx.run(async (tx) => {
    const s = { tenantId, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const platform = await getCommercePlatformFor(s, ctx.tenant);
    const orders = await runOrdersSync(s, platform, { kind: "initial", country: ctx.tenant.country, budgetMs: opts.inlineBudgetMs ?? 15_000, historySince: since });
    if (orders.error) return "inline_error";
    await runCatalogSync(s, platform);
    if (!orders.finished) return "inline_paused";
    await runReturnsSync(s, platform, { kind: "initial", country: ctx.tenant.country, budgetMs: 10_000, historySince: since });
    return "inline_finished";
  });
}
