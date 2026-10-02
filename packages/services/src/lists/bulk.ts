import { and, eq, inArray, recordAudit, schema } from "@keel/db";
import { canTransitionReturn, type BulkCompareAtChange, type BulkPriceChange, type OrderStatus, type TenantSettings } from "@keel/core";
import type { CommercePlatform } from "@keel/integrations";
import type { ServiceContext } from "../context";
import type { AuditIdentity } from "../catalog/costs";
import { setManualStatus } from "../orders/state";
import { assignOrderTo, cancelOrderWithPlatform, updateOrderTagsWithPlatform } from "../orders/writes";
import { setProductStatusWithPlatform, updateProductPricesWithPlatform, updateProductTagsWithPlatform, type ProductStatus } from "../catalog/writes";
import { transitionReturn } from "../returns";
import { syncReturnToPlatform } from "../returns/platform";
import { ReturnError } from "../returns/errors";
import { SkipItem, newBatchId, runBatch, type BatchSummary } from "./batch";

/**
 * Bulk actions on list selections. Each record runs in its own tenant transaction through the same
 * service a single-record action uses (platform first, then the local write), at most `concurrency`
 * at a time; one record failing never stops the others. Every record's audit row and timeline event
 * carry the batch id, and a closing audit row records the counts.
 */
export interface BulkRunner {
  tenantId: string;
  actor: ServiceContext["actor"];
  audit: AuditIdentity;
  /** Opens one tenant transaction (withTenant) and hands it to `fn` as a service context. */
  run<T>(fn: (s: ServiceContext) => Promise<T>): Promise<T>;
}

export interface BulkOptions {
  concurrency: number;
  batchId?: string;
}

async function summarize(runner: BulkRunner, entity: string, action: string, params: Record<string, unknown>, summary: BatchSummary): Promise<BatchSummary> {
  await runner.run((s) => recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action: `bulk.${entity}.${action}`, entityType: entity, metadata: { batchId: summary.batchId, params, total: summary.total, done: summary.done, skipped: summary.skipped, failed: summary.failed, failures: summary.items.filter((i) => i.status !== "done").slice(0, 50).map((i) => ({ id: i.id, status: i.status, reason: i.reason })) } }));
  return summary;
}

async function labels(runner: BulkRunner, table: "orders" | "products" | "returns", ids: string[]): Promise<{ id: string; label: string | null }[]> {
  const rows = await runner.run(async (s) => {
    if (table === "orders") return s.tx.select({ id: schema.orders.id, label: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, s.tenantId), inArray(schema.orders.id, ids)));
    if (table === "products") return s.tx.select({ id: schema.products.id, label: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, s.tenantId), inArray(schema.products.id, ids)));
    return (await s.tx.select({ id: schema.returnRequests.id, n: schema.returnRequests.number }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, s.tenantId), inArray(schema.returnRequests.id, ids)))).map((r) => ({ id: r.id, label: `R-${r.n}` }));
  });
  const byId = new Map(rows.map((r) => [r.id, r.label]));
  return [...new Set(ids)].map((id) => ({ id, label: byId.get(id) ?? null }));
}

/* ---------- orders ---------- */

export type OrderBulkInput =
  | { action: "status"; status: OrderStatus; note?: string | null }
  | { action: "cancel"; reason: string; restock: boolean; refund: boolean }
  | { action: "assign"; userId: string | null }
  | { action: "tag"; add: string[]; remove: string[] };

export async function bulkOrders(runner: BulkRunner, platform: CommercePlatform | undefined, orderIds: string[], input: OrderBulkInput, opts: BulkOptions): Promise<BatchSummary> {
  const batchId = opts.batchId ?? newBatchId();
  const meta = { batchId, source: "bulk" };
  const items = await labels(runner, "orders", orderIds);
  const summary = await runBatch(items, (item) =>
    runner.run(async (s) => {
      const audit = (action: string, diff: Record<string, { from: unknown; to: unknown }>, metadata: Record<string, unknown> = {}) => recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action, entityType: "order", entityId: item.id, diff, metadata: { ...metadata, batchId } });
      if (input.action === "status") {
        const [o] = await s.tx.select({ status: schema.orders.status, manual: schema.orders.manualStatus }).from(schema.orders).where(and(eq(schema.orders.tenantId, s.tenantId), eq(schema.orders.id, item.id))).limit(1);
        if (!o) throw new SkipItem("not_found");
        if (o.status === input.status && o.manual === input.status) throw new SkipItem("unchanged");
        const r = await setManualStatus(s, item.id, input.status, input.note ?? undefined, { eventMetadata: meta });
        if (!r.changed) throw new SkipItem(r.reason === "manual" ? "unchanged" : `overridden:${r.reason}`);
        await audit("order.status_changed", { status: { from: r.previous, to: r.next } }, { note: input.note ?? null });
        return;
      }
      if (input.action === "cancel") {
        const r = await cancelOrderWithPlatform(s, platform, item.id, { reason: input.reason, restock: input.restock, refund: input.refund, source: "bulk", eventMetadata: { batchId } });
        if (r.kind !== "cancelled") throw new SkipItem(r.kind);
        await audit("order.cancelled", {}, { reason: input.reason, restock: input.restock, refund: input.refund });
        return;
      }
      if (input.action === "assign") {
        const r = await assignOrderTo(s, item.id, input.userId, { eventMetadata: meta });
        if (r.kind !== "assigned") throw new SkipItem(r.kind);
        await audit("order.assigned", { assignedTo: { from: r.previous, to: input.userId } });
        return;
      }
      const r = await updateOrderTagsWithPlatform(s, platform, item.id, { add: input.add, remove: input.remove, source: "bulk", eventMetadata: { batchId } });
      if (r.kind !== "updated") throw new SkipItem(r.kind);
      await audit("order.tags_updated", { platformTags: { from: r.from, to: r.to } }, { added: r.added, removed: r.removed });
    }),
  { concurrency: opts.concurrency, batchId });
  return summarize(runner, "order", input.action, { ...input }, summary);
}

/* ---------- products ---------- */

export type ProductBulkInput =
  | { action: "status"; status: ProductStatus }
  | { action: "price"; price: BulkPriceChange }
  | { action: "compare_at"; compareAt: BulkCompareAtChange }
  | { action: "tags"; add: string[]; remove: string[] };

export async function bulkProducts(runner: BulkRunner, platform: CommercePlatform | undefined, productIds: string[], input: ProductBulkInput, opts: BulkOptions): Promise<BatchSummary> {
  const batchId = opts.batchId ?? newBatchId();
  const items = await labels(runner, "products", productIds);
  const summary = await runBatch(items, (item) =>
    runner.run(async (s) => {
      const r =
        input.action === "status" ? await setProductStatusWithPlatform(s, platform, item.id, input.status)
        : input.action === "price" ? await updateProductPricesWithPlatform(s, platform, item.id, { price: input.price }, { source: "bulk", batchId })
        : input.action === "compare_at" ? await updateProductPricesWithPlatform(s, platform, item.id, { compareAt: input.compareAt }, { source: "bulk", batchId })
        : await updateProductTagsWithPlatform(s, platform, item.id, input.add, input.remove);
      if (r.kind !== "updated") throw new SkipItem(r.kind);
      const action = input.action === "status" ? "product.status_updated" : input.action === "tags" ? "product.tags_updated" : "variant.price_updated";
      await recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action, entityType: "product", entityId: item.id, diff: r.diff, metadata: { batchId, source: "bulk" } });
    }),
  { concurrency: opts.concurrency, batchId });
  return summarize(runner, "product", input.action, { ...input }, summary);
}

/* ---------- returns ---------- */

export type ReturnBulkInput = { action: "approve" | "reject" | "refund"; note?: string | null } | { action: "receive"; restockLocationId: string | null; note?: string | null };
const RETURN_TARGET = { approve: "approved", reject: "rejected", receive: "received", refund: "refunded" } as const;

/**
 * Return transitions. The platform write-back (`syncReturnToPlatform`) runs after each record's
 * commit, as for a single return, and never turns a done record into a failure: its error is the
 * record's note, and the return keeps its sync error for the retry button.
 */
export async function bulkReturns(runner: BulkRunner, platform: CommercePlatform | undefined, settings: TenantSettings, returnIds: string[], input: ReturnBulkInput, opts: BulkOptions & { country: string }): Promise<BatchSummary> {
  const batchId = opts.batchId ?? newBatchId();
  const to = RETURN_TARGET[input.action];
  const items = await labels(runner, "returns", returnIds);
  const summary = await runBatch(items, async (item) => {
    await runner.run(async (s) => {
      const [req] = await s.tx.select({ status: schema.returnRequests.status }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, s.tenantId), eq(schema.returnRequests.id, item.id))).limit(1);
      if (!req) throw new SkipItem("not_found");
      if (!canTransitionReturn(req.status, to)) throw new SkipItem(`bad_transition:${req.status}`);
      let restock: { locationId: string; lineIds: string[] } | null = null;
      if (input.action === "receive" && input.restockLocationId) {
        const lines = await s.tx.select({ id: schema.returnLines.id }).from(schema.returnLines).where(and(eq(schema.returnLines.tenantId, s.tenantId), eq(schema.returnLines.returnId, item.id)));
        restock = { locationId: input.restockLocationId, lineIds: lines.map((l) => l.id) };
      }
      try {
        const r = await transitionReturn(s, { returnId: item.id, to, note: input.note ?? null, restock });
        await recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action: `return.${to}`, entityType: "return", entityId: item.id, diff: { status: { from: r.previous, to: r.next } }, metadata: { batchId, source: "bulk" } });
      } catch (e) {
        if (e instanceof ReturnError) throw new SkipItem(e.code);
        throw e;
      }
    });
    if (!settings.returnsWriteBack || !platform) return;
    const sync = await runner.run((s) => syncReturnToPlatform(s, platform, settings, item.id, { country: opts.country }));
    return sync.status === "error" ? { note: `platform_sync_error: ${sync.error ?? ""}`.slice(0, 300) } : undefined;
  }, { concurrency: opts.concurrency, batchId });
  return summarize(runner, "return", input.action, { ...input }, summary);
}
