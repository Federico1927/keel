import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { alias } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/schema";
import { qualified } from "../src/qualified";

const db = drizzle.mock();
const subquery = (outer: unknown) => sql<string | null>`(select v.sku from product_variants v where v.product_id = ${outer} limit 1)`;

describe("qualified", () => {
  it("keeps the table prefix of an outer column in the select list of a single-table query", () => {
    // the trap: Drizzle drops the prefix there, so the subquery would compare v.product_id with v.id
    expect(db.select({ sku: subquery(schema.products.id) }).from(schema.products).toSQL().sql).toBe('select (select v.sku from product_variants v where v.product_id = "id" limit 1) from "products"');
    expect(db.select({ id: schema.products.id, sku: subquery(qualified(schema.products.id)) }).from(schema.products).toSQL().sql).toBe('select "id", (select v.sku from product_variants v where v.product_id = "products"."id" limit 1) from "products"');
  });

  it("renders the same in joined queries, filters and aliased tables", () => {
    const joined = db.select({ sku: subquery(qualified(schema.products.id)) }).from(schema.products).innerJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id)).toSQL().sql;
    expect(joined).toContain('v.product_id = "products"."id"');
    expect(db.select({ n: sql`1` }).from(schema.products).where(sql`exists ${subquery(qualified(schema.products.id))}`).toSQL().sql).toContain('v.product_id = "products"."id"');
    const p = alias(schema.products, "p");
    expect(db.select({ sku: subquery(qualified(p.id)) }).from(p).toSQL().sql).toBe('select (select v.sku from product_variants v where v.product_id = "p"."id" limit 1) from "products" "p"');
  });
});
