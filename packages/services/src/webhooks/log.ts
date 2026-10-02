import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, recordAudit, schema, sql, type SQL } from "@hullwise/db";
import { decodeCursor, encodeCursor, pageOf } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { dispatchWebhook } from "./emit";
import { WebhookError, type WebhookAuditIdentity } from "./endpoints";

/**
 * Delivery log of the outgoing webhooks (#81): filters, keyset pages, the detail with the payload
 * and the attempts, manual redelivery (a new delivery of the same event) and test deliveries.
 */

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "sending", "retrying", "succeeded", "dead", "cancelled"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface DeliveryFilters {
  endpointId?: string;
  status?: string;
  eventType?: string;
  /** Deliveries of one event (all its endpoints and redeliveries). */
  eventId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface DeliveryRow {
  id: string;
  endpointId: string;
  endpointUrl: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  durationMs: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  isTest: boolean;
  redeliveryOf: string | null;
  createdAt: Date;
}

const isUuid = (v: string | undefined | null) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v ?? "");

export async function listWebhookDeliveries(ctx: ServiceContext, f: DeliveryFilters = {}): Promise<{ rows: DeliveryRow[]; nextCursor: string | null }> {
  const d = schema.webhookDeliveries;
  const limit = Math.max(1, Math.min(100, f.limit ?? 50));
  const conds: SQL[] = [eq(d.tenantId, ctx.tenantId)];
  if (f.endpointId) conds.push(isUuid(f.endpointId) ? eq(d.endpointId, f.endpointId) : sql`false`);
  if (f.eventId) conds.push(isUuid(f.eventId) ? eq(d.eventId, f.eventId) : sql`false`);
  if (f.status) conds.push(f.status === "failed" ? inArray(d.status, ["dead", "retrying"]) : eq(d.status, f.status));
  if (f.eventType) conds.push(eq(d.eventType, f.eventType));
  const cursor = f.cursor ? decodeCursor("webhook_deliveries", f.cursor, 2) : null;
  if (cursor) conds.push(sql`(${d.createdAt}, ${d.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`);
  const rows = await ctx.tx
    .select({ id: d.id, endpointId: d.endpointId, endpointUrl: schema.webhookEndpoints.url, eventId: d.eventId, eventType: d.eventType, status: d.status, attempts: d.attempts, responseCode: d.responseCode, durationMs: d.durationMs, lastError: d.lastError, nextAttemptAt: d.nextAttemptAt, deliveredAt: d.deliveredAt, isTest: d.isTest, redeliveryOf: d.redeliveryOf, createdAt: d.createdAt, key: sql<string>`${d.createdAt}::text` })
    .from(d)
    .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, d.endpointId))
    .where(and(...conds))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit, (r) => encodeCursor("webhook_deliveries", [r.key, r.id]));
  return { rows: page.data.map(({ key: _key, ...r }) => r), nextCursor: page.nextCursor };
}

export async function webhookDeliveryDetail(ctx: ServiceContext, deliveryId: string) {
  if (!isUuid(deliveryId)) return null;
  const d = schema.webhookDeliveries;
  const [row] = await ctx.tx.select({ delivery: d, endpointUrl: schema.webhookEndpoints.url }).from(d).innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, d.endpointId)).where(and(eq(d.tenantId, ctx.tenantId), eq(d.id, deliveryId))).limit(1);
  return row ? { ...row.delivery, endpointUrl: row.endpointUrl, attemptLog: (row.delivery.attemptLog as { at: string; code: number | null; durationMs: number; error: string | null }[]) ?? [] } : null;
}

const identityOf = (ctx: ServiceContext, o?: WebhookAuditIdentity): WebhookAuditIdentity => o ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "api" ? "api" : ctx.actor.userId ? "user" : "system", impersonatedBy: null };

/** A new delivery of the same event to the same endpoint (whatever happened to the original), sent now. */
export async function redeliverWebhook(ctx: ServiceContext, deliveryId: string, opts: { audit?: WebhookAuditIdentity } = {}): Promise<{ id: string }> {
  if (!isUuid(deliveryId)) throw new WebhookError("not_found");
  const d = schema.webhookDeliveries;
  const [orig] = await ctx.tx.select().from(d).where(and(eq(d.tenantId, ctx.tenantId), eq(d.id, deliveryId))).limit(1);
  if (!orig) throw new WebhookError("not_found");
  const now = ctx.now ?? new Date();
  const who = identityOf(ctx, opts.audit);
  const [row] = await ctx.tx.insert(d).values({ tenantId: ctx.tenantId, endpointId: orig.endpointId, eventId: orig.eventId, eventType: orig.eventType, payload: orig.payload, status: "pending", nextAttemptAt: now, redeliveryOf: orig.id, isTest: orig.isTest, requestedBy: who.actorUserId, createdAt: now, updatedAt: now }).returning({ id: d.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...who, action: "webhook.redelivered", entityType: "webhook_delivery", entityId: row!.id, diff: {}, metadata: { original: orig.id, eventId: orig.eventId, eventType: orig.eventType } });
  dispatchWebhook({ tenantId: ctx.tenantId, deliveryId: row!.id });
  return { id: row!.id };
}

/** A `webhook.test` event to one endpoint (tried once, even when the endpoint is paused). */
export async function sendTestWebhook(ctx: ServiceContext, endpointId: string, opts: { audit?: WebhookAuditIdentity } = {}): Promise<{ id: string }> {
  if (!isUuid(endpointId)) throw new WebhookError("not_found");
  const [ep] = await ctx.tx.select({ id: schema.webhookEndpoints.id }).from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.tenantId, ctx.tenantId), eq(schema.webhookEndpoints.id, endpointId))).limit(1);
  if (!ep) throw new WebhookError("not_found");
  const now = ctx.now ?? new Date();
  const eventId = randomUUID();
  const who = identityOf(ctx, opts.audit);
  const payload = { id: eventId, type: "webhook.test", apiVersion: "v1", createdAt: now.toISOString(), data: { message: "Test delivery: your endpoint is reachable and can verify the signature." } };
  const [row] = await ctx.tx.insert(schema.webhookDeliveries).values({ tenantId: ctx.tenantId, endpointId, eventId, eventType: "webhook.test", payload, status: "pending", nextAttemptAt: now, isTest: true, requestedBy: who.actorUserId, createdAt: now, updatedAt: now }).returning({ id: schema.webhookDeliveries.id });
  dispatchWebhook({ tenantId: ctx.tenantId, deliveryId: row!.id });
  return { id: row!.id };
}

/** Finished deliveries, request log rows and expired idempotency answers past the retention window. */
export async function purgeApiRows(ctx: ServiceContext, opts: { days: number }): Promise<number> {
  const now = ctx.now ?? new Date();
  const before = new Date(now.getTime() - opts.days * 864e5);
  const d = schema.webhookDeliveries;
  const a = await ctx.tx.delete(d).where(and(eq(d.tenantId, ctx.tenantId), lt(d.createdAt, before), or(inArray(d.status, ["succeeded", "cancelled"]), lt(d.createdAt, new Date(before.getTime() - 30 * 864e5))))).returning({ id: d.id });
  const b = await ctx.tx.delete(schema.apiRequestLog).where(and(eq(schema.apiRequestLog.tenantId, ctx.tenantId), lt(schema.apiRequestLog.createdAt, before))).returning({ id: schema.apiRequestLog.id });
  const c = await ctx.tx.delete(schema.apiIdempotencyKeys).where(and(eq(schema.apiIdempotencyKeys.tenantId, ctx.tenantId), lt(schema.apiIdempotencyKeys.expiresAt, now))).returning({ id: schema.apiIdempotencyKeys.id });
  return a.length + b.length + c.length;
}
