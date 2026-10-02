import { createHmac } from "node:crypto";
import { and, eq, inArray, lt, lte, or, schema, sql, withTenant, type Database } from "@hullwise/db";
import { PRODUCT_NAME, WEBHOOK_HEADERS, WEBHOOK_LIMITS, isModuleInPlan, isTenantOperational } from "@hullwise/config";
import { formatWebhookSignature, isWebhookSuccess, webhookRetryDelaySeconds, webhookSignedContent, type WebhookUrlPolicy } from "@hullwise/core";
import { signingSecrets } from "./endpoints";
import type { WebhookJob } from "./emit";
import { guardedWebhookSend, webhookUrlPolicy, type WebhookSender } from "./transport";

/**
 * Delivery of one webhook (#81): claim the row in a short tenant transaction, send outside any
 * transaction (never hold one across the network), record the attempt in another. Failures retry on
 * the schedule 10 s → 30 s → 2 min → 10 min → 30 min → 1 h → 2 h, then the delivery is dead (kept,
 * redeliverable). The caller (worker job or the web's deferred delivery) schedules the retry it is
 * told about; the `webhooks` tick is the safety net for anything lost.
 */

export interface WebhookDeliverOptions {
  now?: () => Date;
  policy?: WebhookUrlPolicy;
  send?: WebhookSender;
}

export type WebhookDeliverOutcome =
  | { status: "missing" }
  | { status: "skipped"; reason: "finished" | "locked" | "not_due" }
  | { status: "cancelled"; reason: string }
  | { status: "succeeded"; code: number }
  | { status: "retrying"; retryInSeconds: number; code: number | null; error: string | null }
  | { status: "dead"; code: number | null; error: string | null };

const FINISHED = ["succeeded", "dead", "cancelled"];

/** HMAC-SHA256 hex of `<t>.<body>` with one secret. */
export function webhookHmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(webhookSignedContent(timestamp, body)).digest("hex");
}

export function webhookHeaders(input: { deliveryId: string; eventType: string; body: string; secrets: readonly string[]; timestamp: number }): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": `${PRODUCT_NAME}-Webhooks/1`,
    [WEBHOOK_HEADERS.id]: input.deliveryId,
    [WEBHOOK_HEADERS.event]: input.eventType,
    [WEBHOOK_HEADERS.timestamp]: String(input.timestamp),
    [WEBHOOK_HEADERS.signature]: formatWebhookSignature(input.timestamp, input.secrets.map((s) => webhookHmac(s, input.timestamp, input.body))),
  };
}

type AttemptEntry = { at: string; code: number | null; durationMs: number; error: string | null };

export async function deliverWebhook(app: Database, job: WebhookJob, opts: WebhookDeliverOptions = {}): Promise<WebhookDeliverOutcome> {
  const nowOf = () => opts.now?.() ?? new Date();
  const claimed = await withTenant(
    job.tenantId,
    async (tx) => {
      const now = nowOf();
      const d = schema.webhookDeliveries;
      const [row] = await tx.select().from(d).where(and(eq(d.tenantId, job.tenantId), eq(d.id, job.deliveryId))).limit(1).for("update");
      if (!row) return { kind: "missing" as const };
      if (FINISHED.includes(row.status)) return { kind: "skipped" as const, reason: "finished" as const };
      if (row.status === "sending" && row.lockedUntil && row.lockedUntil > now) return { kind: "skipped" as const, reason: "locked" as const };
      if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime() + 1000) return { kind: "skipped" as const, reason: "not_due" as const };
      const cancel = async (reason: string) => {
        await tx.update(d).set({ status: "cancelled", lastError: reason, nextAttemptAt: null, lockedUntil: null, updatedAt: now }).where(eq(d.id, row.id));
        return { kind: "cancelled" as const, reason };
      };
      const [tenant] = await tx.select({ planKey: schema.tenants.planKey, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, job.tenantId)).limit(1);
      if (!tenant || !isModuleInPlan("core.api", tenant.planKey) || !isTenantOperational(tenant.status)) return cancel("api_unavailable");
      const [endpoint] = await tx.select().from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.tenantId, job.tenantId), eq(schema.webhookEndpoints.id, row.endpointId))).limit(1);
      if (!endpoint) return cancel("endpoint_deleted");
      if (!endpoint.isActive && !row.isTest) return cancel("endpoint_disabled");
      await tx.update(d).set({ status: "sending", attempts: row.attempts + 1, lockedUntil: new Date(now.getTime() + WEBHOOK_LIMITS.lockSeconds * 1000), updatedAt: now }).where(eq(d.id, row.id));
      return { kind: "send" as const, row: { ...row, attempts: row.attempts + 1 }, url: endpoint.url, secrets: signingSecrets(endpoint, now) };
    },
    app,
  );
  if (claimed.kind === "missing") return { status: "missing" };
  if (claimed.kind === "skipped") return { status: "skipped", reason: claimed.reason };
  if (claimed.kind === "cancelled") return { status: "cancelled", reason: claimed.reason };

  const { row } = claimed;
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(nowOf().getTime() / 1000);
  const res = await (opts.send ?? guardedWebhookSend)({ url: claimed.url, body, headers: webhookHeaders({ deliveryId: row.id, eventType: row.eventType, body, secrets: claimed.secrets, timestamp }), policy: opts.policy ?? webhookUrlPolicy(), timeoutMs: WEBHOOK_LIMITS.timeoutMs });

  const ok = isWebhookSuccess(res.status);
  // a test delivery is tried once: the person sees the result right away
  const delay = ok || row.isTest ? null : webhookRetryDelaySeconds(row.attempts);
  const now = nowOf();
  const entry: AttemptEntry = { at: now.toISOString(), code: res.status, durationMs: res.durationMs, error: res.error };
  const log = [...((row.attemptLog as AttemptEntry[] | null) ?? []), entry].slice(-10);
  const status = ok ? "succeeded" : delay === null ? "dead" : "retrying";
  await withTenant(
    job.tenantId,
    async (tx) => {
      await tx.update(schema.webhookDeliveries).set({ status, responseCode: res.status, durationMs: res.durationMs, lastError: res.error, responseExcerpt: res.excerpt, attemptLog: log, nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay * 1000), lockedUntil: null, deliveredAt: ok ? now : null, updatedAt: now }).where(eq(schema.webhookDeliveries.id, row.id));
      await tx.update(schema.webhookEndpoints).set(ok ? { lastSuccessAt: now } : { lastFailureAt: now }).where(and(eq(schema.webhookEndpoints.tenantId, job.tenantId), eq(schema.webhookEndpoints.id, row.endpointId)));
    },
    app,
  );
  if (ok) return { status: "succeeded", code: res.status! };
  if (delay === null) return { status: "dead", code: res.status, error: res.error };
  return { status: "retrying", retryInSeconds: delay, code: res.status, error: res.error };
}

/**
 * Deliveries that should have been attempted by now (a lost dispatch, a restart, a retry whose job
 * vanished), across tenants: the `webhooks` tick hands each to the queue. Read through the admin
 * connection like the other ticks' discovery queries; the delivery itself runs under RLS.
 */
export async function dueWebhookDeliveries(admin: Database, opts: { now?: Date; graceSeconds?: number; limit?: number } = {}): Promise<(WebhookJob & { attempts: number })[]> {
  const now = opts.now ?? new Date();
  const due = new Date(now.getTime() - (opts.graceSeconds ?? 20) * 1000);
  const d = schema.webhookDeliveries;
  return admin
    .select({ tenantId: d.tenantId, deliveryId: d.id, attempts: d.attempts })
    .from(d)
    .where(or(and(inArray(d.status, ["pending", "retrying"]), lte(d.nextAttemptAt, due)), and(eq(d.status, "sending"), lt(d.lockedUntil, now))))
    .orderBy(sql`${d.nextAttemptAt} asc nulls first`)
    .limit(opts.limit ?? 500);
}
