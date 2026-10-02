import { and, desc, eq, inArray, recordAudit, schema, sql } from "@hullwise/db";
import type { CommercePlatform } from "@hullwise/integrations";
import { applyCancellation, runPlatformWriteNow, type ServiceContext } from "@hullwise/services";
import type { CarrierRow } from "../carrier-import";
import type { CodSettings } from "../settings";
import { getCodSettings } from "./index";

const auditActor = (ctx: ServiceContext) => ({ actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? ("user" as const) : ("system" as const) });

/* ---------- carrier outcomes import (C.19) ---------- */

/**
 * Stores parsed carrier rows, matching each reference to an order by tracking number first, then by
 * order name (with or without `#`). Re-importing a reference updates it. Unmatched rows are kept:
 * a later sync may bring the order, and they count in the import summary.
 */
export async function importCarrierOutcomes(ctx: ServiceContext, rows: readonly CarrierRow[], opts: { batch: string }): Promise<{ imported: number; matched: number; unmatched: string[] }> {
  if (!rows.length) return { imported: 0, matched: 0, unmatched: [] };
  const refs = [...new Set(rows.map((r) => r.reference.trim()))];
  const byTracking = await ctx.tx.select({ ref: schema.shipments.trackingNumber, orderId: schema.shipments.orderId }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), inArray(schema.shipments.trackingNumber, refs)));
  const names = refs.flatMap((r) => [r, r.startsWith("#") ? r.slice(1) : `#${r}`]).map((r) => r.toLowerCase());
  const byName = await ctx.tx.select({ name: schema.orders.name, id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(sql`lower(${schema.orders.name})`, names)));
  const find = (ref: string): string | null => byTracking.find((t) => t.ref === ref)?.orderId ?? byName.find((n) => [ref, ref.replace(/^#/, ""), `#${ref.replace(/^#/, "")}`].map((x) => x.toLowerCase()).includes(n.name.toLowerCase()))?.id ?? null;
  const unmatched: string[] = [];
  let matched = 0;
  const now = ctx.now ?? new Date();
  for (const r of rows) {
    const orderId = find(r.reference.trim());
    if (orderId) matched++;
    else unmatched.push(r.reference);
    const values = { orderId, outcome: r.outcome, occurredAt: r.occurredAt, costMinor: r.costMinor, importBatch: opts.batch, importedBy: ctx.actor.userId };
    await ctx.tx.insert(schema.codCarrierOutcomes).values({ tenantId: ctx.tenantId, reference: r.reference.trim(), ...values, createdAt: now }).onConflictDoUpdate({ target: [schema.codCarrierOutcomes.tenantId, schema.codCarrierOutcomes.reference], set: values });
  }
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.carrier_outcomes_imported", entityType: "cod_carrier_outcomes", entityId: opts.batch, metadata: { rows: rows.length, matched, unmatched: unmatched.length } });
  return { imported: rows.length, matched, unmatched };
}

/** Recent import batches with their counts. */
export async function carrierImportSummary(ctx: ServiceContext) {
  return ctx.tx
    .select({ batch: schema.codCarrierOutcomes.importBatch, at: sql<Date>`max(${schema.codCarrierOutcomes.createdAt})`, rows: sql<number>`count(*)::int`, matched: sql<number>`count(${schema.codCarrierOutcomes.orderId})::int`, refused: sql<number>`count(*) filter (where ${schema.codCarrierOutcomes.outcome} = 'refused')::int` })
    .from(schema.codCarrierOutcomes)
    .where(eq(schema.codCarrierOutcomes.tenantId, ctx.tenantId))
    .groupBy(schema.codCarrierOutcomes.importBatch)
    .orderBy(desc(sql`max(${schema.codCarrierOutcomes.createdAt})`))
    .limit(10);
}

/* ---------- return to sender automation ---------- */

/**
 * Behind `rtsAutoCancel`: a COD order whose parcel is back at the sender (core return-to-sender
 * review case, #28) and was never paid is cancelled on the platform without restock, which voids the
 * pending payment there; Hullwise records the cancellation (payment `voided`) and closes its queue item.
 * The review case stays open for a person (restock is a physical check). A refused platform call
 * leaves the order untouched for the next run.
 */
export async function autoCancelReturnedToSender(ctx: ServiceContext, opts: { platform?: CommercePlatform; settings?: CodSettings }): Promise<{ cancelled: number; failed: number }> {
  const settings = opts.settings ?? (await getCodSettings(ctx));
  if (!settings.rtsAutoCancel) return { cancelled: 0, failed: 0 };
  const due = await ctx.tx
    .selectDistinct({ orderId: schema.orders.id, externalId: schema.orders.externalId, caseId: schema.shipmentCases.id })
    .from(schema.shipmentCases)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipmentCases.orderId))
    .where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.kind, "return_to_sender"), sql`${schema.shipmentCases.closedAt} is null`, eq(schema.orders.paymentMethod, "cod"), eq(schema.orders.paymentStatus, "pending"), sql`${schema.orders.cancelledAt} is null`))
    .limit(200);
  let cancelled = 0;
  let failed = 0;
  const now = ctx.now ?? new Date();
  for (const d of due) {
    if (opts.platform && d.externalId) {
      try {
        await runPlatformWriteNow(ctx, opts.platform, { kind: "order.cancel", entityType: "order", entityId: d.orderId, payload: { orderExternalId: d.externalId, reason: "other", restock: false, refund: false }, idempotencyKey: `cod:rts:${d.orderId}` });
      } catch {
        failed++;
        continue;
      }
    }
    await applyCancellation(ctx, d.orderId, { reason: "cod_return_to_sender", restock: false, refund: false, source: "cod", eventMetadata: { caseId: d.caseId, automation: "rts_auto_cancel" } });
    await ctx.tx.update(schema.codQueueItems).set({ status: "cancelled", closedAt: now, updatedAt: now }).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, d.orderId), inArray(schema.codQueueItems.status, ["pending", "scheduled", "unreachable", "confirm_scheduled"])));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.rts_auto_cancelled", entityType: "order", entityId: d.orderId, diff: { paymentStatus: { from: "pending", to: "voided" } }, metadata: { caseId: d.caseId, restock: false } });
    cancelled++;
  }
  return { cancelled, failed };
}
