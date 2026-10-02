"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_CONCURRENCY, BULK_MAX_ITEMS, canWritePage } from "@hullwise/config";
import { ADJUSTMENT_REASONS } from "@hullwise/core";
import { InventoryControlError, adjustStock, applyMarkdowns, applyStockTake, cancelStockTake, createStockTake, recordStockTakeCount, setStockTakeCount, type BatchSummary, type BulkRunner, type ScanOutcome, type ServiceContext } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/** Inventory control actions (issue #30): `inventory` write (owner, admin, operations); markdowns also need `products` write. */

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

function mapError<T>(e: unknown): ActionResult<T> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof InventoryControlError) return fail(e.code === "not_found" ? "not_found" : "invalid_input", { reason: e.code });
  throw e;
}

const adjustSchema = z.object({ variantId: z.string().uuid(), locationId: z.string().uuid(), delta: z.coerce.number().int().min(-1_000_000).max(1_000_000), reason: z.enum(ADJUSTMENT_REASONS), note: z.string().trim().max(500).optional() });

export async function adjustStockAction(slug: string, _prev: ActionResult<{ after: number }> | null, formData: FormData): Promise<ActionResult<{ after: number }>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = adjustSchema.safeParse({ variantId: formData.get("variantId"), locationId: formData.get("locationId"), delta: formData.get("delta"), reason: formData.get("reason"), note: formData.get("note") || undefined });
    if (!parsed.success) return fail("invalid_input");
    const r = await ctx.run((tx) => adjustStock(svc(ctx, tx), parsed.data, { audit: auditActor(ctx) }));
    // the new level, then the platform holds lifted for orders the found units released
    await dispatchPlatformWrites(ctx, [r.write, ...r.coverage.writes]);
    revalidatePath(`/t/${slug}/inventory`);
    revalidatePath(`/t/${slug}/products`, "layout");
    if (r.coverage.releasedOrders.length) revalidatePath(`/t/${slug}/orders`);
    return ok({ after: r.after });
  } catch (e) {
    return mapError(e);
  }
}

export async function createStockTakeAction(slug: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = z.object({ locationId: z.string().uuid(), note: z.string().trim().max(500).optional() }).safeParse({ locationId: formData.get("locationId"), note: formData.get("note") || undefined });
    if (!parsed.success) return fail("invalid_input");
    const r = await ctx.run((tx) => createStockTake(svc(ctx, tx), parsed.data, { audit: auditActor(ctx) }));
    revalidatePath(`/t/${slug}/inventory/stock-takes`);
    return ok({ id: r.id });
  } catch (e) {
    return mapError(e);
  }
}

const scanSchema = z.object({ code: z.string().trim().min(1).max(120), quantity: z.coerce.number().int().min(0).max(1_000_000), mode: z.enum(["add", "set"]) });

export async function scanStockTakeAction(slug: string, stockTakeId: string, input: { code: string; quantity: number; mode: "add" | "set" }): Promise<ActionResult<ScanOutcome>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = scanSchema.safeParse(input);
    if (!parsed.success || !z.string().uuid().safeParse(stockTakeId).success) return fail("invalid_input");
    const r = await ctx.run((tx) => recordStockTakeCount(svc(ctx, tx), stockTakeId, parsed.data));
    revalidatePath(`/t/${slug}/inventory/stock-takes/${stockTakeId}`);
    return ok(r);
  } catch (e) {
    return mapError(e);
  }
}

export async function setStockTakeCountAction(slug: string, stockTakeId: string, countId: string, counted: number | null): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    if (!z.string().uuid().safeParse(stockTakeId).success || !z.string().uuid().safeParse(countId).success || !z.number().int().min(0).max(1_000_000).nullable().safeParse(counted).success) return fail("invalid_input");
    await ctx.run((tx) => setStockTakeCount(svc(ctx, tx), stockTakeId, countId, counted));
    revalidatePath(`/t/${slug}/inventory/stock-takes/${stockTakeId}`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function applyStockTakeAction(slug: string, stockTakeId: string): Promise<ActionResult<{ movements: number; released: number }>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    if (!z.string().uuid().safeParse(stockTakeId).success) return fail("invalid_input");
    const r = await ctx.run((tx) => applyStockTake(svc(ctx, tx), stockTakeId, { audit: auditActor(ctx) }));
    await dispatchPlatformWrites(ctx, [...r.writes, ...r.coverage.writes]);
    revalidatePath(`/t/${slug}/inventory/stock-takes/${stockTakeId}`);
    revalidatePath(`/t/${slug}/inventory/stock-takes`);
    revalidatePath(`/t/${slug}/inventory`);
    if (r.coverage.releasedOrders.length) revalidatePath(`/t/${slug}/orders`);
    return ok({ movements: r.movements, released: r.coverage.releasedOrders.length });
  } catch (e) {
    return mapError(e);
  }
}

export async function cancelStockTakeAction(slug: string, stockTakeId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    if (!z.string().uuid().safeParse(stockTakeId).success) return fail("invalid_input");
    await ctx.run((tx) => cancelStockTake(svc(ctx, tx), stockTakeId, { audit: auditActor(ctx) }));
    revalidatePath(`/t/${slug}/inventory/stock-takes/${stockTakeId}`);
    revalidatePath(`/t/${slug}/inventory/stock-takes`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

/** Applies the selected markdowns (recomputed per variant on the server, never below the margin floor), then sends the price writes. */
export async function applyMarkdownsAction(slug: string, variantIds: unknown): Promise<ActionResult<BatchSummary>> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    if (!canWritePage(ctx.role, "products")) throw new ForbiddenError("write:products");
    const ids = z.array(z.string().uuid()).min(1).max(BULK_MAX_ITEMS).safeParse(variantIds);
    if (!ids.success) return fail("invalid_input");
    const runner: BulkRunner = { tenantId: ctx.tenant.id, actor: { type: "user", userId: ctx.user.id }, audit: auditActor(ctx), run: (fn) => ctx.run((tx) => fn(svc(ctx, tx))) };
    const { summary, writes } = await applyMarkdowns(runner, { country: ctx.tenant.country, settings: ctx.settings }, ids.data, { concurrency: BULK_CONCURRENCY });
    await dispatchPlatformWrites(ctx, writes);
    revalidatePath(`/t/${slug}/inventory/markdowns`);
    revalidatePath(`/t/${slug}/products`, "layout");
    return ok(summary);
  } catch (e) {
    return mapError(e);
  }
}
