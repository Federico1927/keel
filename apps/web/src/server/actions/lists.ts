"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_CONCURRENCY, BULK_MAX_ITEMS, canBulk, canViewPage, isListKey, type BulkList, type PageKey } from "@hullwise/config";
import { ORDER_STATUSES, type OrderStatus } from "@hullwise/core";
import { adminDb, and, eq, recordAudit, schema } from "@hullwise/db";
import { SavedViewError, bulkOrders, bulkProducts, bulkReturns, deleteView, globalSearch, saveView, type BatchSummary, type BulkRunner, type GlobalSearchResult, type SearchArea } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, getTenantContext, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const ids = z.array(z.string().uuid()).min(1).max(BULK_MAX_ITEMS);
const tags = z.array(z.string().trim().min(1).max(60)).max(20).default([]);

function runnerFor(ctx: TenantContext): BulkRunner {
  return { tenantId: ctx.tenant.id, actor: { type: "user", userId: ctx.user.id }, audit: auditActor(ctx), run: (fn) => ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } })) };
}

async function requireBulk(slug: string, list: BulkList, action: string): Promise<TenantContext> {
  const ctx = await getTenantContext(slug);
  if (!canBulk(ctx.role, list, action)) throw new ForbiddenError(`bulk:${list}.${action}`);
  return ctx;
}

/* ---------- bulk actions ---------- */

const orderBulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), status: z.enum(ORDER_STATUSES as unknown as [OrderStatus, ...OrderStatus[]]), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal("cancel"), reason: z.enum(["customer", "inventory", "fraud", "declined", "other"]), restock: z.boolean(), refund: z.boolean() }),
  z.object({ action: z.literal("assign"), userId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("tag"), add: tags, remove: tags }),
]);

export async function bulkOrdersAction(slug: string, orderIds: unknown, input: unknown): Promise<ActionResult<BatchSummary>> {
  try {
    const parsed = orderBulkSchema.safeParse(input);
    const list = ids.safeParse(orderIds);
    if (!parsed.success || !list.success) return fail("invalid_input");
    if (parsed.data.action === "tag" && !parsed.data.add.length && !parsed.data.remove.length) return fail("invalid_input");
    const ctx = await requireBulk(slug, "orders", parsed.data.action);
    if (parsed.data.action === "assign" && parsed.data.userId) {
      const [m] = await adminDb().select({ id: schema.tenantMemberships.id }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.userId, parsed.data.userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
      if (!m) return fail("invalid_input");
    }
    const platform = parsed.data.action === "cancel" || parsed.data.action === "tag" ? await getCommercePlatform(ctx) : undefined;
    const summary = await bulkOrders(runnerFor(ctx), platform, list.data, parsed.data, { concurrency: BULK_CONCURRENCY });
    revalidatePath(`/t/${slug}/orders`);
    return ok(summary);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const money = z.number().int().min(0).max(100_000_000);
const productBulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), status: z.enum(["active", "draft", "archived"]) }),
  z.object({ action: z.literal("price"), price: z.discriminatedUnion("mode", [z.object({ mode: z.literal("set"), valueMinor: money }), z.object({ mode: z.literal("percent"), bps: z.number().int().min(-9000).max(50_000) })]) }),
  z.object({ action: z.literal("compare_at"), compareAt: z.discriminatedUnion("mode", [z.object({ mode: z.literal("set"), valueMinor: money }), z.object({ mode: z.literal("clear") })]) }),
  z.object({ action: z.literal("tags"), add: tags, remove: tags }),
]);

export async function bulkProductsAction(slug: string, productIds: unknown, input: unknown): Promise<ActionResult<BatchSummary>> {
  try {
    const parsed = productBulkSchema.safeParse(input);
    const list = ids.safeParse(productIds);
    if (!parsed.success || !list.success) return fail("invalid_input");
    if (parsed.data.action === "tags" && !parsed.data.add.length && !parsed.data.remove.length) return fail("invalid_input");
    const ctx = await requireBulk(slug, "products", parsed.data.action);
    const summary = await bulkProducts(runnerFor(ctx), await getCommercePlatform(ctx), list.data, parsed.data, { concurrency: BULK_CONCURRENCY });
    revalidatePath(`/t/${slug}/products`);
    return ok(summary);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const returnBulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["approve", "reject", "refund"]), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal("receive"), restockLocationId: z.string().uuid().nullable(), note: z.string().max(500).nullish() }),
]);

export async function bulkReturnsAction(slug: string, returnIds: unknown, input: unknown): Promise<ActionResult<BatchSummary>> {
  try {
    const parsed = returnBulkSchema.safeParse(input);
    const list = ids.safeParse(returnIds);
    if (!parsed.success || !list.success) return fail("invalid_input");
    const ctx = await requireBulk(slug, "returns", parsed.data.action);
    const platform = ctx.settings.returnsWriteBack ? await getCommercePlatform(ctx) : undefined;
    const summary = await bulkReturns(runnerFor(ctx), platform, ctx.settings, list.data, parsed.data, { concurrency: BULK_CONCURRENCY, country: ctx.tenant.country });
    revalidatePath(`/t/${slug}/returns`);
    return ok(summary);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/* ---------- saved views ---------- */

const viewSchema = z.object({ list: z.string(), name: z.string().trim().min(1).max(60), query: z.string().max(2000), isShared: z.boolean() });

export async function saveViewAction(slug: string, input: unknown): Promise<ActionResult<{ id: string; replaced: boolean }>> {
  try {
    const parsed = viewSchema.safeParse(input);
    if (!parsed.success || !isListKey(parsed.data.list)) return fail("invalid_input");
    const ctx = await getTenantContext(slug);
    if (!canViewPage(ctx.role, parsed.data.list as PageKey)) return fail("forbidden");
    const r = await ctx.run(async (tx) => {
      const res = await saveView({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { pageKey: parsed.data.list, name: parsed.data.name, query: parsed.data.query, isShared: parsed.data.isShared, userId: ctx.user.id });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: res.replaced ? "saved_view.updated" : "saved_view.created", entityType: "saved_view", entityId: res.id, metadata: { list: parsed.data.list, name: parsed.data.name, shared: parsed.data.isShared } });
      return res;
    });
    revalidatePath(`/t/${slug}/${parsed.data.list}`);
    return ok(r);
  } catch (e) {
    if (e instanceof SavedViewError) return fail(e.code === "invalid_name" ? "invalid_input" : e.code);
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function deleteViewAction(slug: string, viewId: string): Promise<ActionResult> {
  try {
    if (!z.string().uuid().safeParse(viewId).success) return fail("invalid_input");
    const ctx = await getTenantContext(slug);
    const view = await ctx.run(async (tx) => {
      const v = await deleteView({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, viewId, ctx.user.id, ctx.role === "owner" || ctx.role === "admin");
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "saved_view.deleted", entityType: "saved_view", entityId: viewId, metadata: { list: v.pageKey, name: v.name, shared: v.isShared, query: v.query } });
      return v;
    });
    revalidatePath(`/t/${slug}/${view.pageKey}`);
    return ok();
  } catch (e) {
    if (e instanceof SavedViewError) return fail(e.code);
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/* ---------- ⌘K ---------- */

const SEARCH_AREAS: SearchArea[] = ["orders", "customers", "products", "purchasing"];

/** One request, one tenant transaction; only the areas the role can open (and that are enabled). */
export async function globalSearchAction(slug: string, query: string): Promise<ActionResult<GlobalSearchResult>> {
  try {
    const q = String(query ?? "").slice(0, 120);
    const ctx = await getTenantContext(slug);
    const areas = SEARCH_AREAS.filter((a) => canViewPage(ctx.role, a));
    const r = await ctx.run((tx) => globalSearch({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, q, { country: ctx.tenant.country, orderNumberPrefix: ctx.tenant.orderNumberPrefix, areas }));
    return ok(r);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
