import { and, eq, schema, sql } from "@hullwise/db";
import { isPageEnabled } from "@hullwise/config";
import { SUBSCRIPTION_SEGMENT_GROUP } from "@hullwise/core";
import type { TenantContext } from "@/server/tenant";

/** Option lists the segment builder needs for dynamic enum/array fields. */
export async function segmentBuilderOptions(ctx: TenantContext) {
  return ctx.run(async (tx) => {
    const countries = await tx.execute<{ v: string }>(sql`select distinct country as v from customers where tenant_id = ${ctx.tenant.id} and country is not null order by 1`);
    const types = await tx.execute<{ v: string }>(sql`select distinct product_type as v from products where tenant_id = ${ctx.tenant.id} and product_type is not null order by 1`);
    const tags = await tx.execute<{ v: string }>(sql`select distinct unnest(tags) as v from customers where tenant_id = ${ctx.tenant.id} order by 1 limit 200`);
    const products = await tx.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.status, "active"))).orderBy(schema.products.title).limit(500);
    const methods = await tx.execute<{ v: string }>(sql`select distinct payment_method as v from orders where tenant_id = ${ctx.tenant.id} order by 1`);
    // option names and values of the catalog's variants (any name: Size, Taglia, Material…), for "dominant option"
    const opts = await tx.execute<{ k: string; v: string }>(sql`select distinct e.key as k, e.value as v from product_variants pv cross join lateral jsonb_each_text(case when jsonb_typeof(pv.option_values) = 'object' then pv.option_values else '{}'::jsonb end) e where pv.tenant_id = ${ctx.tenant.id} order by 1, 2 limit 2000`);
    const optionValues: Record<string, string[]> = {};
    for (const r of opts.rows) (optionValues[r.k] ??= []).push(r.v);
    // addon.subscriptions (#67): its fields are offered only with the add-on
    const hiddenGroups = isPageEnabled("subscriptions", ctx.activeAddons) ? [] : [SUBSCRIPTION_SEGMENT_GROUP];
    return { countries: countries.rows.map((r) => r.v), productTypes: types.rows.map((r) => r.v), tags: tags.rows.map((r) => r.v), products, paymentMethods: methods.rows.map((r) => r.v), optionValues, hiddenGroups };
  });
}

export function decodeRulesParam(raw: string | undefined): unknown | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
export function encodeRulesParam(rules: unknown): string {
  return Buffer.from(JSON.stringify(rules), "utf8").toString("base64url");
}
