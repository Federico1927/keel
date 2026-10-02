import { and, eq, inArray, schema } from "@hullwise/db";
import { executePlatformWrite, type PlatformWriteRow, type ServiceContext, type TenantRunner } from "@hullwise/services";
import { enqueue } from "./jobs";
import type { TenantContext } from "./tenant";

/** Longest wait the request accepts when the platform asks to retry shortly (rate limit). */
const MAX_INLINE_WAIT_MS = 2_000;

/** Short tenant transactions for the outbox executor, acting as the signed-in user. */
export function tenantRunner(ctx: TenantContext): TenantRunner {
  return <T>(fn: (s: ServiceContext) => Promise<T>) => ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
}

/**
 * Runs the platform writes an action enqueued, once its transaction has committed: handed to the
 * worker when one is deployed (`HULLWISE_JOBS_QUEUE=1`), executed inline otherwise, with one short
 * retry when the platform asks to wait under two seconds. Whatever is left (a longer rate limit,
 * an outage) stays pending with its badge and goes out on the next retry tick or manual retry.
 */
export async function dispatchPlatformWrites(ctx: TenantContext, writes: (Pick<PlatformWriteRow, "id" | "status" | "mode"> | null | undefined)[]): Promise<void> {
  for (const w of writes) {
    if (!w || w.mode !== "async" || w.status !== "pending") continue;
    if (await enqueue("platform.write", { tenantId: ctx.tenant.id, writeId: w.id }, { singletonKey: w.id })) continue;
    const r = await executePlatformWrite(tenantRunner(ctx), ctx.tenant, w.id);
    if (r.status === "pending" && r.retryInMs !== undefined && r.retryInMs <= MAX_INLINE_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, r.retryInMs));
      await executePlatformWrite(tenantRunner(ctx), ctx.tenant, w.id);
    }
  }
}

/** For services that enqueue internally: dispatches the pending writes of these records. */
export async function dispatchPendingWritesFor(ctx: TenantContext, entityType: string, entityIds: string[]): Promise<void> {
  if (!entityIds.length) return;
  const rows = await ctx.run((tx) => tx.select({ id: schema.platformWrites.id, status: schema.platformWrites.status, mode: schema.platformWrites.mode }).from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenant.id), eq(schema.platformWrites.entityType, entityType), inArray(schema.platformWrites.entityId, entityIds), eq(schema.platformWrites.status, "pending"), eq(schema.platformWrites.mode, "async"))));
  await dispatchPlatformWrites(ctx, rows);
}
