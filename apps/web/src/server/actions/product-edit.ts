"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@hullwise/db";
import { IntegrationError } from "@hullwise/integrations";
import { editProductMedia, editProductWithPlatform, getCommercePlatformFor, runCatalogSync, syncProductFromPlatform, type ServiceContext } from "@hullwise/services";
import { enqueue } from "@/server/jobs";
import { ForbiddenError, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Product page edits (issue #19): platform first through the outbox, local rows from the
 * platform's answer, one audit entry each. A stale edit answers `stale` ("changed in Shopify,
 * reload"); a platform refusal answers `platform_error` with its message and changes nothing.
 */

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const text = (max: number) => z.string().max(max);
const money = z.number().int().min(0).max(1_000_000_000);
const editSchema = z.object({
  productId: z.string().uuid(),
  version: z.string().max(40).nullable(),
  product: z.object({ title: text(255), descriptionHtml: text(60_000).nullable(), vendor: text(255).nullable(), productType: text(255).nullable(), tags: z.array(text(255)).max(250), status: z.enum(["active", "draft", "archived"]), seoTitle: text(70).nullable(), seoDescription: text(320).nullable(), categoryId: text(255).nullable() }).partial().optional(),
  variants: z.array(z.object({ variantId: z.string().uuid(), priceMinor: money, compareAtMinor: money.nullable(), sku: text(255).nullable(), barcode: text(255).nullable(), weightGrams: z.number().int().min(0).max(10_000_000).nullable(), inventoryPolicy: z.enum(["deny", "continue"]) }).partial().required({ variantId: true })).max(250).optional(),
});
const mediaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), url: z.string().url().max(2000), alt: text(512).nullable() }),
  z.object({ type: z.literal("reorder"), mediaIds: z.array(z.string().uuid()).min(1).max(250) }),
  z.object({ type: z.literal("delete"), mediaIds: z.array(z.string().uuid()).min(1).max(250) }),
  z.object({ type: z.literal("alt"), mediaId: z.string().uuid(), alt: text(512).nullable() }),
]);

function platformError(e: unknown): ActionResult<never> | null {
  return e instanceof IntegrationError ? fail("platform_error", { platform: e.message }) : null;
}

export async function saveProductAction(slug: string, input: unknown): Promise<ActionResult<{ status: "updated" | "unchanged" }>> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const { productId, ...edit } = parsed.data;
    const out = await ctx.run(async (tx) => editProductWithPlatform(svc(ctx, tx), await getCommercePlatformFor(svc(ctx, tx), ctx.tenant), productId, edit, auditActor(ctx)));
    if (out.kind === "not_found") return fail("not_found");
    if (out.kind === "invalid") return fail("invalid_input", { form: out.error });
    if (out.kind === "stale") {
      revalidatePath(`/t/${slug}/products/${productId}`);
      return fail("stale");
    }
    revalidatePath(`/t/${slug}/products/${productId}`);
    revalidatePath(`/t/${slug}/products`);
    return ok({ status: out.kind });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const pe = platformError(e);
    if (pe) return pe;
    throw e;
  }
}

export async function productMediaAction(slug: string, productId: string, version: string | null, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = mediaSchema.safeParse(input);
    if (!z.string().uuid().safeParse(productId).success || !parsed.success) return fail("invalid_input");
    const out = await ctx.run(async (tx) => editProductMedia(svc(ctx, tx), await getCommercePlatformFor(svc(ctx, tx), ctx.tenant), productId, { ...parsed.data, version }, auditActor(ctx)));
    revalidatePath(`/t/${slug}/products/${productId}`);
    if (out.kind === "not_found") return fail("not_found");
    if (out.kind === "invalid") return fail("invalid_input");
    if (out.kind === "stale") return fail("stale");
    revalidatePath(`/t/${slug}/products`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const pe = platformError(e);
    if (pe) return pe;
    throw e;
  }
}

/** "Sync from Shopify" on the product page: one product, now. */
export async function syncProductAction(slug: string, productId: string): Promise<ActionResult<{ changed: number }>> {
  try {
    const ctx = await requireWrite(slug, "products");
    if (!z.string().uuid().safeParse(productId).success) return fail("invalid_input");
    const out = await ctx.run(async (tx) => syncProductFromPlatform(svc(ctx, tx), await getCommercePlatformFor(svc(ctx, tx), ctx.tenant), productId, auditActor(ctx)));
    if (out.kind === "not_found") return fail("not_found");
    revalidatePath(`/t/${slug}/products/${productId}`);
    return ok({ changed: Object.keys(out.diff).length });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    const pe = platformError(e);
    if (pe) return pe;
    throw e;
  }
}

/** "Sync from Shopify" on the Products list: the whole catalog run, queued with a worker, inline (resumable) otherwise. */
export async function syncCatalogAction(slug: string): Promise<ActionResult<{ queued: boolean; finished: boolean; products: number }>> {
  try {
    const ctx = await requireWrite(slug, "products");
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "catalog.sync_requested", entityType: "integration", entityId: "shopify" }));
    if (await enqueue("sync.catalog", { tenantId: ctx.tenant.id, kind: "manual", scope: "catalog" }, { singletonKey: `${ctx.tenant.id}:catalog:catalog` })) return ok({ queued: true, finished: false, products: 0 });
    const r = await ctx.run(async (tx) => runCatalogSync(svc(ctx, tx), await getCommercePlatformFor(svc(ctx, tx), ctx.tenant), { kind: "manual", scope: "catalog", budgetMs: 20_000 }));
    if (r.error) return fail("platform_error", { platform: r.error });
    revalidatePath(`/t/${slug}/products`, "layout");
    return ok({ queued: false, finished: r.finished, products: r.products });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
