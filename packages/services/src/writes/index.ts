import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, ne, schema, sql } from "@keel/db";
import { IntegrationError, type AdsPlatform, type CommercePlatform } from "@keel/integrations";
import type { ServiceContext } from "../context";
import type { TenantRunner } from "../assistant";
import type { AdPlatform } from "@keel/core";
import { AdPlatformNotInPlanError, getAdsPlatformFor, getCommercePlatformFor, type PlatformTenant } from "../integrations/factory";
import { recordHealth } from "../sync";
import { writeHandler, type PlatformWriteKind, type PlatformWriteRow, type WritePayload, type WriteResult } from "./registry";
import "./kinds";

export * from "./registry";
export { reviveOrder } from "./kinds";

/**
 * Outbound write outbox. A user action changes Keel and enqueues the platform write in the same
 * transaction; the write runs right after (a pg-boss job, or inline when no worker is deployed)
 * and is retried with backoff on rate limits and network errors. The same request repeated
 * (double click, retry) maps to the same row, so it reaches the platform once.
 */

/** Same payload on the same target within this window = the same request. */
export const WRITE_DEDUPE_WINDOW_MS = 10 * 60_000;
const RETRYABLE: IntegrationError["code"][] = ["rate_limited", "network", "unknown"];
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
/** A write still `running` after this long was interrupted (process restart): it goes back to pending. */
const STALE_RUNNING_MS = 10 * 60_000;

export interface PlatformWriteInput<K extends PlatformWriteKind> {
  kind: K;
  /** Keel record the write belongs to: the status badge reads it. */
  entityType: string;
  entityId?: string | null;
  payload: WritePayload<K>;
  /** Caller-chosen key (absolute: the same key is always the same write). Default: derived from kind, target, payload and the previous write on the target. */
  idempotencyKey?: string;
  maxAttempts?: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
/** JSON-safe copy of a payload or result (Dates → ISO strings), as it will be stored. */
const toJson = (v: unknown) => (v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown));

function handlerOf<K extends PlatformWriteKind>(kind: K | string) {
  const h = writeHandler<K>(kind);
  if (!h) throw new Error(`platform write kind not registered: ${kind}`);
  return h;
}

interface Prepared {
  provider: string;
  targetKey: string;
  payloadHash: string;
  key: string;
  /** The latest write on the target carries the same payload and is recent: same request. */
  reuse: PlatformWriteRow | null;
}

async function prepare<K extends PlatformWriteKind>(ctx: ServiceContext, input: PlatformWriteInput<K>): Promise<Prepared> {
  const h = handlerOf(input.kind);
  const now = ctx.now ?? new Date();
  const payloadHash = sha(stableJson(input.payload));
  const targetKey = h.target(input.payload);
  if (input.idempotencyKey) {
    const [same] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.idempotencyKey, input.idempotencyKey))).limit(1);
    return { provider: h.provider(input.payload), targetKey, payloadHash, key: input.idempotencyKey, reuse: same ?? null };
  }
  const [latest] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.kind, input.kind), eq(schema.platformWrites.targetKey, targetKey))).orderBy(desc(schema.platformWrites.createdAt)).limit(1);
  const reuse = latest && latest.payloadHash === payloadHash && latest.status !== "superseded" && now.getTime() - latest.createdAt.getTime() < WRITE_DEDUPE_WINDOW_MS ? latest : null;
  // the previous write on the target is part of the key: A → B → A again is three writes, a double click is one
  const key = sha(`${input.kind}|${targetKey}|${payloadHash}|${latest?.id ?? "-"}`);
  return { provider: h.provider(input.payload), targetKey, payloadHash, key, reuse };
}

/** Puts a failed write back in line (manual retry, or the same request sent again). */
async function requeue(ctx: ServiceContext, w: PlatformWriteRow): Promise<PlatformWriteRow> {
  const [row] = await ctx.tx.update(schema.platformWrites).set({ status: "pending", nextAttemptAt: ctx.now ?? new Date(), maxAttempts: Math.max(w.maxAttempts, w.attempts + 3), updatedAt: ctx.now ?? new Date() }).where(eq(schema.platformWrites.id, w.id)).returning();
  return row!;
}

/**
 * Records a platform write to run after the caller's transaction commits. Returns the outbox row:
 * an existing one when the same request was already made. Hand the id to the dispatcher (web:
 * `dispatchPlatformWrites`; jobs: the `platform.write` queue) once the transaction is committed.
 */
export async function enqueuePlatformWrite<K extends PlatformWriteKind>(ctx: ServiceContext, input: PlatformWriteInput<K>): Promise<PlatformWriteRow> {
  const p = await prepare(ctx, input);
  if (p.reuse) return p.reuse.status === "failed" && p.reuse.mode === "async" ? requeue(ctx, p.reuse) : p.reuse;
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx
    .insert(schema.platformWrites)
    .values({ tenantId: ctx.tenantId, provider: p.provider, kind: input.kind, mode: "async", entityType: input.entityType, entityId: input.entityId ?? null, targetKey: p.targetKey, payload: toJson(input.payload) as Record<string, unknown>, payloadHash: p.payloadHash, idempotencyKey: p.key, status: "pending", maxAttempts: input.maxAttempts ?? 6, nextAttemptAt: now, actorType: ctx.actor.type, actorUserId: ctx.actor.userId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // a concurrent identical request won the insert
    const [same] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.idempotencyKey, p.key))).limit(1);
    return same!;
  }
  if (handlerOf(input.kind).supersedes) {
    // only the last absolute value matters: older writes still waiting on this target are dropped
    await ctx.tx.update(schema.platformWrites).set({ status: "superseded", completedAt: now, updatedAt: now }).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.targetKey, p.targetKey), eq(schema.platformWrites.kind, input.kind), inArray(schema.platformWrites.status, ["pending", "failed"]), ne(schema.platformWrites.id, row.id)));
  }
  return row;
}

/**
 * Executes a write now, with an adapter the caller already holds, for flows that need the
 * platform's answer to continue (a replacement order and its number, a return id, COD tags that
 * must land before the operator moves on). The call is recorded in the outbox with its outcome.
 * With an `idempotencyKey` the same key returns the stored result instead of writing twice, and a
 * failed attempt is retried on the same row; without one every call is recorded on its own (the
 * flow guards its steps). Errors are rethrown: when the caller's transaction rolls back, so does
 * the record.
 */
export async function runPlatformWriteNow<K extends PlatformWriteKind>(ctx: ServiceContext, adapter: CommercePlatform | AdsPlatform, input: PlatformWriteInput<K>): Promise<WriteResult<K>> {
  const h = handlerOf(input.kind);
  // flows guard their own steps: without a caller key every call is its own record
  const p = input.idempotencyKey ? await prepare(ctx, input) : { ...(await prepare(ctx, input)), key: `sync:${randomUUID()}`, reuse: null };
  const now = ctx.now ?? new Date();
  if (p.reuse?.status === "succeeded") return (h.revive ? h.revive(p.reuse.result) : p.reuse.result) as WriteResult<K>;
  let row: PlatformWriteRow;
  if (p.reuse) row = (await ctx.tx.update(schema.platformWrites).set({ status: "running", attempts: p.reuse.attempts + 1, startedAt: now, updatedAt: now }).where(eq(schema.platformWrites.id, p.reuse.id)).returning())[0]!;
  else {
    const [ins] = await ctx.tx
      .insert(schema.platformWrites)
      .values({ tenantId: ctx.tenantId, provider: p.provider, kind: input.kind, mode: "sync", entityType: input.entityType, entityId: input.entityId ?? null, targetKey: p.targetKey, payload: toJson(input.payload) as Record<string, unknown>, payloadHash: p.payloadHash, idempotencyKey: p.key, status: "running", attempts: 1, maxAttempts: 1, nextAttemptAt: now, actorType: ctx.actor.type, actorUserId: ctx.actor.userId, startedAt: now, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!ins) {
      const [same] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.idempotencyKey, p.key))).limit(1);
      if (same?.status === "succeeded") return (h.revive ? h.revive(same.result) : same.result) as WriteResult<K>;
      throw new IntegrationError("invalid_request", "The same platform write is already in progress");
    }
    row = ins;
  }
  try {
    const result = await h.execute(adapter, input.payload);
    const [done] = await ctx.tx.update(schema.platformWrites).set({ status: "succeeded", result: toJson(result) as Record<string, unknown>, lastError: null, lastErrorCode: null, completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.platformWrites.id, row.id)).returning();
    await h.onSuccess?.(ctx, done!, result);
    return result;
  } catch (e) {
    const code = e instanceof IntegrationError ? e.code : "unknown";
    await ctx.tx.update(schema.platformWrites).set({ status: "failed", lastError: errorText(e), lastErrorCode: code, completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.platformWrites.id, row.id));
    throw e;
  }
}

const errorText = (e: unknown) => (e instanceof Error ? `${e instanceof IntegrationError ? `[${e.code}] ` : ""}${e.message}` : String(e)).slice(0, 500);

export interface ExecuteOutcome {
  id: string;
  status: "succeeded" | "pending" | "failed" | "skipped";
  error?: string;
  errorCode?: string;
  /** When a retry is scheduled: in how long. */
  retryInMs?: number;
}

/**
 * Runs one outbox write: claim (row lock, `running`), call the platform outside any transaction,
 * record the outcome. Retryable errors (rate limit, network) reschedule with backoff, honouring
 * the platform's Retry-After; others fail at once. `force` ignores the schedule (manual retry).
 */
export async function executePlatformWrite(run: TenantRunner, tenant: PlatformTenant, writeId: string, opts: { force?: boolean; now?: Date } = {}): Promise<ExecuteOutcome> {
  const claimed = await run(async (ctx) => {
    const now = opts.now ?? new Date();
    const [w] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.id, writeId))).limit(1).for("update", { skipLocked: true });
    if (!w || w.mode !== "async") return null;
    if (w.status !== "pending" && !(opts.force && w.status === "failed")) return null;
    if (!opts.force && w.nextAttemptAt.getTime() > now.getTime()) return null;
    const h = writeHandler(w.kind);
    if (!h) {
      await ctx.tx.update(schema.platformWrites).set({ status: "failed", lastError: `Unknown write kind ${w.kind}`, lastErrorCode: "unsupported", completedAt: now }).where(eq(schema.platformWrites.id, w.id));
      return null;
    }
    let adapter: CommercePlatform | AdsPlatform;
    try {
      adapter = w.provider === "shopify" ? await getCommercePlatformFor(ctx, tenant) : await getAdsPlatformFor(ctx, tenant, w.provider as AdPlatform);
    } catch (e) {
      // a platform the plan no longer includes: the write can never run, so it fails instead of retrying
      if (!(e instanceof AdPlatformNotInPlanError)) throw e;
      await ctx.tx.update(schema.platformWrites).set({ status: "failed", lastError: e.message, lastErrorCode: "permission", completedAt: now }).where(eq(schema.platformWrites.id, w.id));
      return null;
    }
    const [row] = await ctx.tx.update(schema.platformWrites).set({ status: "running", attempts: w.attempts + 1, startedAt: now, updatedAt: now }).where(eq(schema.platformWrites.id, w.id)).returning();
    return { w: row!, h, adapter };
  });
  if (!claimed) return { id: writeId, status: "skipped" };
  const { w, h, adapter } = claimed;
  let result: unknown;
  let error: unknown = null;
  try {
    result = await h.execute(adapter, w.payload as never);
  } catch (e) {
    error = e;
  }
  return run(async (ctx) => {
    const now = new Date();
    if (!error) {
      const [done] = await ctx.tx.update(schema.platformWrites).set({ status: "succeeded", result: toJson(result) as Record<string, unknown>, lastError: null, lastErrorCode: null, completedAt: now, updatedAt: now }).where(eq(schema.platformWrites.id, w.id)).returning();
      await h.onSuccess?.(ctx, done!, result as never);
      await recordHealth(ctx, `${w.provider}:writes`, true, { rowsWritten: 1, freshnessMinutes: 24 * 60, touchIntegration: false });
      return { id: w.id, status: "succeeded" as const };
    }
    const code = error instanceof IntegrationError ? error.code : "unknown";
    const message = errorText(error);
    const retry = RETRYABLE.includes(code) && w.attempts < w.maxAttempts;
    // the first rate limit waits exactly what the platform asks; repeated failures back off exponentially
    const retryAfter = error instanceof IntegrationError ? error.retryAfterMs : undefined;
    const retryInMs = retry ? Math.min(BACKOFF_MAX_MS, retryAfter !== undefined && w.attempts <= 1 ? retryAfter : Math.max(retryAfter ?? 0, BACKOFF_BASE_MS * 2 ** (w.attempts - 1))) : undefined;
    await ctx.tx.update(schema.platformWrites).set({ status: retry ? "pending" : "failed", nextAttemptAt: retry ? new Date(now.getTime() + retryInMs!) : w.nextAttemptAt, lastError: message, lastErrorCode: code, completedAt: retry ? null : now, updatedAt: now }).where(eq(schema.platformWrites.id, w.id));
    if (!retry) await recordHealth(ctx, `${w.provider}:writes`, false, { error: message, touchIntegration: false });
    return { id: w.id, status: retry ? ("pending" as const) : ("failed" as const), error: message, errorCode: code, retryInMs };
  });
}

/**
 * The retry loop (worker tick, every minute): writes whose time has come, oldest first. A rate
 * limit stops the batch for that provider so the platform gets breathing room. Writes left
 * `running` by an interrupted process go back to pending first.
 */
export async function processDuePlatformWrites(run: TenantRunner, tenant: PlatformTenant, opts: { limit?: number; now?: Date } = {}): Promise<{ processed: number; succeeded: number; failed: number; retrying: number; recovered: number }> {
  const now = opts.now ?? new Date();
  const { due, recovered } = await run(async (ctx) => {
    const stale = await ctx.tx.update(schema.platformWrites).set({ status: "pending", nextAttemptAt: now }).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.status, "running"), eq(schema.platformWrites.mode, "async"), lte(schema.platformWrites.startedAt, new Date(now.getTime() - STALE_RUNNING_MS)))).returning({ id: schema.platformWrites.id });
    const rows = await ctx.tx.select({ id: schema.platformWrites.id, provider: schema.platformWrites.provider }).from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.status, "pending"), eq(schema.platformWrites.mode, "async"), lte(schema.platformWrites.nextAttemptAt, now))).orderBy(schema.platformWrites.createdAt).limit(opts.limit ?? 100);
    return { due: rows, recovered: stale.length };
  });
  const out = { processed: 0, succeeded: 0, failed: 0, retrying: 0, recovered };
  const throttled = new Set<string>();
  for (const d of due) {
    if (throttled.has(d.provider)) continue;
    const r = await executePlatformWrite(run, tenant, d.id, { now });
    if (r.status === "skipped") continue;
    out.processed++;
    if (r.status === "succeeded") out.succeeded++;
    else if (r.status === "failed") out.failed++;
    else out.retrying++;
    if (r.errorCode === "rate_limited") throttled.add(d.provider);
  }
  return out;
}

/** Manual retry from the UI: a failed (or waiting) asynchronous write goes back in line now. Sync writes are re-run by their own flow. */
export async function retryPlatformWrite(ctx: ServiceContext, writeId: string): Promise<PlatformWriteRow | null> {
  const [w] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.id, writeId))).limit(1);
  if (!w || w.mode !== "async" || !["failed", "pending"].includes(w.status)) return null;
  return requeue(ctx, w);
}

export async function getPlatformWrite(ctx: ServiceContext, writeId: string): Promise<PlatformWriteRow | null> {
  const [w] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.id, writeId))).limit(1);
  return w ?? null;
}

export type PlatformWriteSummary = Pick<PlatformWriteRow, "id" | "kind" | "mode" | "status" | "attempts" | "lastError" | "lastErrorCode" | "nextAttemptAt" | "createdAt" | "completedAt" | "entityType" | "entityId">;

/** Latest write per record (superseded ones skipped), for the status badges of a page. */
export async function latestPlatformWrites(ctx: ServiceContext, entityType: string, entityIds: string[], opts: { kinds?: string[] } = {}): Promise<Map<string, PlatformWriteSummary>> {
  if (!entityIds.length) return new Map();
  const where = [eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.entityType, entityType), inArray(schema.platformWrites.entityId, entityIds), ne(schema.platformWrites.status, "superseded")];
  if (opts.kinds?.length) where.push(inArray(schema.platformWrites.kind, opts.kinds));
  const rows = await ctx.tx.selectDistinctOn([schema.platformWrites.entityId], { id: schema.platformWrites.id, kind: schema.platformWrites.kind, mode: schema.platformWrites.mode, status: schema.platformWrites.status, attempts: schema.platformWrites.attempts, lastError: schema.platformWrites.lastError, lastErrorCode: schema.platformWrites.lastErrorCode, nextAttemptAt: schema.platformWrites.nextAttemptAt, createdAt: schema.platformWrites.createdAt, completedAt: schema.platformWrites.completedAt, entityType: schema.platformWrites.entityType, entityId: schema.platformWrites.entityId }).from(schema.platformWrites).where(and(...where)).orderBy(schema.platformWrites.entityId, desc(schema.platformWrites.createdAt));
  return new Map(rows.map((r) => [r.entityId!, r]));
}

/** Integrations page: recent writes and counts by status. */
export async function platformWritesOverview(ctx: ServiceContext, opts: { limit?: number } = {}) {
  const rows = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), ne(schema.platformWrites.status, "superseded"))).orderBy(desc(schema.platformWrites.createdAt)).limit(opts.limit ?? 20);
  const [counts] = await ctx.tx.select({ pending: sql<number>`count(*) filter (where ${schema.platformWrites.status} in ('pending','running'))::int`, failed: sql<number>`count(*) filter (where ${schema.platformWrites.status} = 'failed')::int`, succeeded24h: sql<number>`count(*) filter (where ${schema.platformWrites.status} = 'succeeded' and ${schema.platformWrites.completedAt} > now() - interval '24 hours')::int` }).from(schema.platformWrites).where(eq(schema.platformWrites.tenantId, ctx.tenantId));
  return { rows, counts: counts ?? { pending: 0, failed: 0, succeeded24h: 0 } };
}

/** Targets with a Keel write not yet confirmed by the platform: a sync must not overwrite them with the old value. */
export async function unconfirmedWriteTargets(ctx: ServiceContext, kinds: PlatformWriteKind | PlatformWriteKind[], targetKeys?: string[]): Promise<Set<string>> {
  const where = [eq(schema.platformWrites.tenantId, ctx.tenantId), inArray(schema.platformWrites.kind, Array.isArray(kinds) ? kinds : [kinds]), inArray(schema.platformWrites.status, ["pending", "running", "failed"])];
  if (targetKeys) {
    if (!targetKeys.length) return new Set();
    where.push(inArray(schema.platformWrites.targetKey, targetKeys));
  }
  const rows = await ctx.tx.selectDistinct({ t: schema.platformWrites.targetKey }).from(schema.platformWrites).where(and(...where));
  return new Set(rows.map((r) => r.t));
}
