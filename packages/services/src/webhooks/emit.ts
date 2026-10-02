import { randomUUID } from "node:crypto";
import { and, eq, schema } from "@hullwise/db";
import type { WebhookEventType } from "@hullwise/config";
import type { ServiceContext } from "../context";

/**
 * Outgoing webhooks (#81), emitting side. Services call `emitWebhookEvent` where the change happens
 * (the status engine, the order import, shipments, returns, stock, products): one delivery row per
 * active endpoint subscribed to the type, in the caller's transaction (a rolled-back change never
 * sends anything). The delivery id goes to the dispatcher (pg-boss on the worker, a deferred
 * in-process delivery on the web without worker); the `webhooks` tick picks up anything missed.
 */

export interface WebhookJob {
  tenantId: string;
  deliveryId: string;
}

type EndpointRef = { id: string; eventTypes: string[] };

/** Active endpoints per transaction: emitting from a loop of 500 imported orders reads them once. */
const endpointCache = new WeakMap<object, Promise<EndpointRef[]>>();

function activeEndpoints(ctx: ServiceContext): Promise<EndpointRef[]> {
  let p = endpointCache.get(ctx.tx);
  if (!p) {
    p = ctx.tx.select({ id: schema.webhookEndpoints.id, eventTypes: schema.webhookEndpoints.eventTypes }).from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.tenantId, ctx.tenantId), eq(schema.webhookEndpoints.isActive, true)));
    endpointCache.set(ctx.tx, p);
  }
  return p;
}

/** After an endpoint changes in this transaction. */
export function forgetWebhookEndpoints(ctx: ServiceContext): void {
  endpointCache.delete(ctx.tx);
}

/** Cheap check before building an expensive payload (stock totals, product variants). */
export async function hasWebhookSubscribers(ctx: ServiceContext, type: WebhookEventType): Promise<boolean> {
  return (await activeEndpoints(ctx)).some((e) => e.eventTypes.includes(type));
}

export async function emitWebhookEvent(ctx: ServiceContext, type: WebhookEventType, data: Record<string, unknown>): Promise<{ eventId: string | null; deliveryIds: string[] }> {
  const targets = (await activeEndpoints(ctx)).filter((e) => e.eventTypes.includes(type));
  if (!targets.length) return { eventId: null, deliveryIds: [] };
  const eventId = randomUUID();
  const now = ctx.now ?? new Date();
  const payload = { id: eventId, type, apiVersion: "v1", createdAt: now.toISOString(), data };
  const rows = await ctx.tx
    .insert(schema.webhookDeliveries)
    .values(targets.map((e) => ({ tenantId: ctx.tenantId, endpointId: e.id, eventId, eventType: type, payload, status: "pending", nextAttemptAt: now, createdAt: now, updatedAt: now })))
    .returning({ id: schema.webhookDeliveries.id });
  for (const r of rows) dispatchWebhook({ tenantId: ctx.tenantId, deliveryId: r.id });
  return { eventId, deliveryIds: rows.map((r) => r.id) };
}

/* ---------- dispatcher ---------- */

export type WebhookDispatcher = (job: WebhookJob) => void | Promise<void>;
const store = globalThis as typeof globalThis & { __hullwiseWebhookQueue?: { dispatcher: WebhookDispatcher | null; pending: WebhookJob[] } };
const queue = () => (store.__hullwiseWebhookQueue ??= { dispatcher: null, pending: [] });

/** Installed once per process: the web app (pg-boss or deferred inline delivery) and the worker (pg-boss). */
export function setWebhookDispatcher(dispatcher: WebhookDispatcher | null): void {
  queue().dispatcher = dispatcher;
}

/** Hands a delivery to the dispatcher (called before the emitting transaction commits: the delivery waits a moment or retries "missing"). */
export function dispatchWebhook(job: WebhookJob): void {
  const q = queue();
  if (!q.dispatcher) {
    // scripts and tests without a dispatcher: kept for `drainWebhookJobs`, bounded (the tick catches up anyway)
    if (q.pending.length < 1000) q.pending.push(job);
    return;
  }
  Promise.resolve()
    .then(() => q.dispatcher!(job))
    .catch((e: unknown) => console.warn("[webhooks] dispatch failed:", e instanceof Error ? e.message : e));
}

/** Jobs queued while no dispatcher was installed, removed from the queue. */
export function drainWebhookJobs(): WebhookJob[] {
  return queue().pending.splice(0);
}
