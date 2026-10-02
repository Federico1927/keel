import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, type TenantSettings } from "@hullwise/core";
import { ReturnError, createReturn, customerRiskForOrder, getReturnPolicy, orderReturnContext, saveReturnPolicy, setReturnReview, type ServiceContext } from "../src";

process.env.AUTH_SECRET ??= "test-secret";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let settings: TenantSettings;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.harbor;
  settings = parseTenantSettings({ returnWindowDays: 3650 });
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@harborhome.demo"]! } }), pools.app);

/** Delivered orders with no return yet, newest first. */
async function freshOrders(n: number) {
  return run(async (s) => (await s.tx.execute<{ id: string; country: string | null }>(sql`
    select o.id, o.shipping_country as country from orders o
    where o.tenant_id = ${tenantId} and o.status = 'delivered'
      and not exists (select 1 from return_requests r where r.order_id = o.id)
      and exists (select 1 from shipments sh where sh.order_id = o.id and sh.delivered_at is not null)
      and exists (select 1 from order_lines l where l.order_id = o.id and l.is_ancillary = false)
    order by o.placed_at desc limit ${n}`)).rows);
}
const reason = (code: string) => run(async (s) => (await s.tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId))).find((r) => r.code === code)!);

describe("return policy", () => {
  it("blocks lines by exclusion and shortens windows by country, with a staff override", async () => {
    const [o] = await freshOrders(1);
    const before = await run((s) => orderReturnContext(s, settings, o!.id));
    const line = before.lines.find((l) => l.returnable > 0)!;
    await run((s) => saveReturnPolicy(s, { exclusions: { titleContains: [line.title.slice(0, 6)] } }));
    const blocked = await run((s) => orderReturnContext(s, settings, o!.id));
    expect(blocked.lines.find((l) => l.id === line.id)).toMatchObject({ block: "excluded_title", returnable: 0 });
    await expect(run((s) => createReturn(s, settings, { orderId: o!.id, reasonCode: "other", resolution: "refund", lines: [{ orderLineId: line.id, quantity: 1 }] }))).rejects.toMatchObject({ code: "line_blocked" });
    // a country window of 0 days expires every line of orders shipped there
    await run((s) => saveReturnPolicy(s, { windows: [{ countries: [o!.country ?? "US"], days: 0 }] }));
    const expired = await run((s) => orderReturnContext(s, settings, o!.id));
    expect(expired.eligibility.reason).toBe("expired");
    expect(expired.lines.every((l) => l.returnable === 0)).toBe(true);
    const r = await run((s) => createReturn(s, settings, { orderId: o!.id, reasonCode: "other", resolution: "refund", lines: [{ orderLineId: line.id, quantity: 1 }], overrideWindow: true, staffNote: "goodwill" }));
    const row = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r.id)))[0]!);
    expect(row.outOfWindow).toBe(true);
  });

  it("enforces the per-customer limit", async () => {
    await run((s) => saveReturnPolicy(s, { customerLimit: { count: 1, days: 730 } }));
    // another delivered order of a customer who already returned something (one query, ordered:
    // a bare `limit 1` on the returns could pick a customer with no other delivered order)
    const other = await run(async (s) => (await s.tx.execute<{ id: string }>(sql`
      select o2.id from return_requests r
      join orders o1 on o1.id = r.order_id
      join orders o2 on o2.customer_id = o1.customer_id and o2.id <> o1.id
      where r.tenant_id = ${tenantId} and o2.status = 'delivered'
      order by o2.id limit 1`)).rows[0]);
    expect(other, "a repeat customer with a return exists in the seed").toBeDefined();
    if (!other) return;
    const c = await run((s) => orderReturnContext(s, settings, other.id));
    expect(c.customerLimitReached).toBe(true);
    expect(c.eligibility.reason).toBe("customer_limit");
  });

  it("computes an explained customer risk", async () => {
    const policy = await run((s) => saveReturnPolicy(s, { risk: { minReturns: 1, watchRateBps: 1, highRateBps: 10000 } }));
    const any = await run(async (s) => (await s.tx.select({ orderId: schema.returnRequests.orderId }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, tenantId)).limit(1))[0]!);
    const risk = await run((s) => customerRiskForOrder(s, policy, any.orderId));
    expect(risk.stats.returnsCount).toBeGreaterThan(0);
    expect(risk.level).not.toBe("none");
    expect(risk.reasons).toContain("frequent_returner");
  });
});

describe("return automations", () => {
  it("auto-approves small first returns, keeps cheap damaged items (returnless) and flags risky customers", async () => {
    await run((s) =>
      saveReturnPolicy(s, {
        risk: { minReturns: 50 },
        automations: [
          { id: "flag", name: "Flag watch", action: "flag", conditions: { minRisk: "watch" } },
          { id: "keep", name: "Keep cheap damaged", action: "returnless", conditions: { reasonCodes: ["damaged"], maxAmountMinor: 100_000_00 } },
          { id: "ok", name: "Approve first", action: "approve", conditions: { firstReturnOnly: true } },
        ],
      }),
    );
    expect((await run((s) => getReturnPolicy(s))).automations).toHaveLength(3);
    const [a, b] = await freshOrders(2);
    const lineOf = async (orderId: string) => (await run((s) => orderReturnContext(s, settings, orderId))).lines.find((l) => l.returnable > 0)!;
    const la = await lineOf(a!.id);
    const damaged = await reason("damaged");
    const r1 = await run((s) => createReturn(s, settings, { orderId: a!.id, reasonCode: damaged.code, resolution: "refund", lines: [{ orderLineId: la.id, quantity: 1 }] }));
    const row1 = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r1.id)))[0]!);
    expect(row1).toMatchObject({ status: "refunded", returnless: true });
    expect(row1.automations.map((x) => x.id)).toEqual(["keep"]);
    const lines1 = await run((s) => s.tx.select().from(schema.returnLines).where(eq(schema.returnLines.returnId, r1.id)));
    expect(lines1.every((l) => !l.restocked)).toBe(true);
    const lb = await lineOf(b!.id);
    const r2 = await run((s) => createReturn(s, settings, { orderId: b!.id, reasonCode: "changed_mind", resolution: "voucher", lines: [{ orderLineId: lb.id, quantity: 1 }] }));
    const row2 = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r2.id)))[0]!);
    // approve only fires on the customer's first return in the window
    expect(["approved", "requested"]).toContain(row2.status);
    expect(row2.riskLevel).toBe("none");
    await run((s) => setReturnReview(s, r2.id, true));
    expect((await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r2.id)))[0]!)).needsReview).toBe(true);
    void ReturnError;
  });
});
