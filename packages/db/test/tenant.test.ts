import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";
import { withTenant } from "../src/tenant";
import { testPools } from "../src/test-utils";
import { seedPlatform } from "../src/seed";

const pools = testPools();
let tenantA = "";
let tenantB = "";

beforeAll(async () => {
  const ctx = await seedPlatform(pools.admin);
  tenantA = ctx.tenantIds.northwind;
  tenantB = ctx.tenantIds.harbor;
});
afterAll(() => pools.close());

describe("withTenant", () => {
  it("rejects invalid ids", async () => {
    await expect(withTenant("nope", async () => 1, pools.app)).rejects.toThrow();
  });
  it("sets the tenant setting inside the transaction only", async () => {
    const inside = await withTenant(
      tenantA,
      async (tx) => {
        const r = await tx.execute<{ v: string }>("select current_setting('app.tenant_id', true) as v");
        return r.rows[0]?.v;
      },
      pools.app,
    );
    expect(inside).toBe(tenantA);
    const outside = await pools.app.execute<{ v: string | null }>("select current_setting('app.tenant_id', true) as v");
    expect(outside.rows[0]?.v ?? "").toBe("");
  });
  it("isolates tenant_tax_rates between tenants", async () => {
    const a = await withTenant(tenantA, (tx) => tx.select().from(schema.tenantTaxRates), pools.app);
    const b = await withTenant(tenantB, (tx) => tx.select().from(schema.tenantTaxRates), pools.app);
    expect(a.every((r) => r.tenantId === tenantA)).toBe(true);
    expect(b.every((r) => r.tenantId === tenantB)).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    const cross = await withTenant(
      tenantB,
      (tx) => tx.select().from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, tenantA)),
      pools.app,
    );
    expect(cross).toHaveLength(0);
  });
});
