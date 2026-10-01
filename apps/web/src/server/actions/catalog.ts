"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@keel/db";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const priceSchema = z.object({ variantId: z.string().uuid(), priceMinor: z.coerce.number().int().min(0) });
const statusSchema = z.object({ productId: z.string().uuid(), status: z.enum(["active", "draft", "archived"]) });

/** Price change: platform first, then local. */
export async function updateVariantPrice(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = priceSchema.safeParse({ variantId: formData.get("variantId"), priceMinor: Math.round(Number(formData.get("price")) * 100) });
    if (!parsed.success) return fail("invalid_input");
    const variant = await ctx.run(async (tx) => (await tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.id, parsed.data.variantId))).limit(1))[0]);
    if (!variant) return fail("not_found");
    const platform = await getCommercePlatform(ctx);
    if (variant.externalId) {
      try {
        await platform.updateVariant(variant.externalId, { priceMinor: parsed.data.priceMinor });
      } catch (e) {
        return fail("platform_error", { platform: e instanceof Error ? e.message : String(e) });
      }
    }
    await ctx.run(async (tx) => {
      await tx.update(schema.productVariants).set({ priceMinor: parsed.data.priceMinor }).where(eq(schema.productVariants.id, variant.id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "variant.price_updated", entityType: "variant", entityId: variant.id, diff: { priceMinor: { from: variant.priceMinor, to: parsed.data.priceMinor } } });
    });
    revalidatePath(`/t/${slug}/products/${variant.productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function updateProductStatus(slug: string, productId: string, status: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = statusSchema.safeParse({ productId, status });
    if (!parsed.success) return fail("invalid_input");
    const product = await ctx.run(async (tx) => (await tx.select().from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, productId))).limit(1))[0]);
    if (!product) return fail("not_found");
    const platform = await getCommercePlatform(ctx);
    if (product.externalId) {
      try {
        await platform.updateProductStatus(product.externalId, parsed.data.status);
      } catch (e) {
        return fail("platform_error", { platform: e instanceof Error ? e.message : String(e) });
      }
    }
    await ctx.run(async (tx) => {
      await tx.update(schema.products).set({ status: parsed.data.status }).where(eq(schema.products.id, productId));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "product.status_updated", entityType: "product", entityId: productId, diff: { status: { from: product.status, to: parsed.data.status } } });
    });
    revalidatePath(`/t/${slug}/products/${productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function toggleRepurchasable(slug: string, productId: string, value: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    await ctx.run(async (tx) => {
      await tx.update(schema.products).set({ isRepurchasable: value }).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, productId)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "product.repurchasable_updated", entityType: "product", entityId: productId, diff: { isRepurchasable: { from: !value, to: value } } });
    });
    revalidatePath(`/t/${slug}/products/${productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
