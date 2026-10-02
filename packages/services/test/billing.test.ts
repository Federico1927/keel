import { MODULES, PLANS } from "@hullwise/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedPlatform, type SeedContext } from "@hullwise/db/seed";
import {
  MockBillingProvider,
  applySuspensions,
  createTenant,
  ensureSubscription,
  issueDueInvoices,
  platformMetrics,
  recordInvoicePayment,
  setTenantAddon,
  setTenantPlan,
  tenantChecklist,
  tenantPaymentStatus,
  tenantsOverview,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let admin = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  admin = ctx.userIds["superadmin@hullwise.demo"]!;
});
afterAll(() => pools.close());

describe("tenant lifecycle and billing", () => {
  const provider = new MockBillingProvider();
  const now = new Date("2026-10-01T09:00:00Z");

  it("creates a tenant with owner, defaults, trial subscription and setup invoice; the checklist reflects it", async () => {
    const r = await createTenant(
      pools.admin,
      {
        name: "Acme Bikes",
        slug: "acme-bikes",
        country: "DE",
        currency: "EUR",
        timezone: "Europe/Berlin",
        defaultLocale: "en",
        orderNumberPrefix: "AB-",
        planKey: "growth",
        taxRateBps: 1900,
        ownerEmail: "owner@acme.test",
        ownerName: "Anna Acme",
      },
      admin,
      { now, provider },
    );
    // the owner is invited (no password anywhere): the checklist says so until they accept
    expect(r.invitationId).toBeTruthy();
    const [inv] = await pools.admin.select().from(schema.invitations).where(eq(schema.invitations.id, r.invitationId));
    expect(inv).toMatchObject({ tenantId: r.tenantId, email: "owner@acme.test", role: "owner", status: "pending" });
    expect(await pools.admin.select().from(schema.users).where(eq(schema.users.email, "owner@acme.test"))).toHaveLength(0);
    const checklist = await tenantChecklist(pools.admin, r.tenantId, now);
    const by = Object.fromEntries(checklist.map((c) => [c.key, c]));
    expect(by.company!.done).toBe(true);
    expect(by.owner).toMatchObject({ done: false, detail: "invited" });
    expect(by.state_rules!.done).toBe(true);
    expect(by.shopify!.done).toBe(false);
    expect(by.billing!.done).toBe(true);
    const invoices = await pools.admin
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.tenantId, r.tenantId));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      kind: "setup",
      amountMinor: PLANS.growth.setupFeeMinor,
      status: "open",
    });
    await expect(
      createTenant(
        pools.admin,
        {
          name: "Dup",
          slug: "acme-bikes",
          country: "DE",
          currency: "EUR",
          timezone: "Europe/Berlin",
          defaultLocale: "en",
          orderNumberPrefix: "D-",
          planKey: "starter",
          taxRateBps: 0,
          ownerEmail: "x@acme.test",
          ownerName: "X",
        },
        admin,
        { now, provider },
      ),
    ).rejects.toThrow("slug_taken");
  });

  it("issues monthly invoices when the period ends, suspends after the grace period and reactivates on payment", async () => {
    const [tenant] = await pools.admin
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, "acme-bikes"));
    const tenantId = tenant!.id;
    await setTenantAddon(pools.admin, tenantId, "addon.cod", true, admin, "pilot");
    await setTenantPlan(pools.admin, tenantId, "starter", admin);
    const afterTrial = new Date("2026-10-20T09:00:00Z");
    const issued = await issueDueInvoices(pools.admin, { now: afterTrial, provider });
    expect(issued.issued).toBeGreaterThanOrEqual(1);
    const invs = await pools.admin
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.kind, "subscription")));
    expect(invs).toHaveLength(1);
    expect(invs[0]!.amountMinor).toBe(
      PLANS.starter.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!,
    );
    const again = await issueDueInvoices(pools.admin, { now: afterTrial, provider });
    const invs2 = await pools.admin
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.kind, "subscription")));
    expect(invs2).toHaveLength(invs.length + (again.issued ? 0 : 0));
    // 30 days after due → beyond the 14-day grace → suspended
    const late = new Date("2026-11-30T09:00:00Z");
    const pay = await tenantPaymentStatus(pools.admin, tenantId, late);
    expect(pay.health).toBe("suspended");
    await applySuspensions(pools.admin, { now: late });
    const [suspended] = await pools.admin
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    expect(suspended!.status).toBe("suspended");
    const [sub] = await pools.admin
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.tenantId, tenantId));
    expect(sub!.status).toBe("suspended");
    for (const inv of await pools.admin
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.status, "open"))))
      await recordInvoicePayment(pools.admin, inv.id, admin, late);
    const [active] = await pools.admin
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    expect(active!.status).toBe("active");
    const auditRows = await pools.admin
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.tenantId, tenantId),
          eq(schema.auditLogs.action, "tenant.reactivated"),
        ),
      );
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it("overview and metrics aggregate the platform", async () => {
    const overview = await tenantsOverview(pools.admin);
    expect(overview.length).toBeGreaterThanOrEqual(3);
    const acme = overview.find((t) => t.slug === "acme-bikes")!;
    expect(acme.addons).toContain("addon.cod");
    expect(acme.payment).toBe("ok");
    const metrics = await platformMetrics(pools.admin);
    expect(metrics.mrrMinor).toBeGreaterThan(0);
    expect(metrics.addons.find((a) => a.key === "addon.cod")!.count).toBeGreaterThanOrEqual(2);
    expect(metrics.tenants.total).toBe(overview.length);
    const sub = await ensureSubscription(pools.admin, acme.id);
    expect(sub.tenantId).toBe(acme.id);
  });
});

describe("add-on versions (#77)", () => {
  const acme = async () => (await pools.admin.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, "acme-bikes")))[0]!.id;
  const row = async (tenantId: string, key: string) => (await pools.admin.select().from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, key))))[0];

  it("switches on only a released version and records which one", async () => {
    const tenantId = await acme();
    expect((await row(tenantId, "addon.cod"))?.version).toBe(1);
    await expect(setTenantAddon(pools.admin, tenantId, "addon.customer_campaigns", true, admin, "try")).rejects.toThrow("addon_not_released");
    expect(await row(tenantId, "addon.customer_campaigns")).toBeUndefined();
    const audits = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.entityId, "addon.customer_campaigns")));
    expect(audits).toHaveLength(0);
  });

  it("an add-on active before its release can be switched off, and not on again", async () => {
    const tenantId = await acme();
    await pools.admin.insert(schema.tenantAddons).values({ tenantId, moduleKey: "addon.customer_campaigns", note: "preview" });
    // saving the note of the active add-on is not an activation
    await setTenantAddon(pools.admin, tenantId, "addon.customer_campaigns", true, admin, "still preview");
    await setTenantAddon(pools.admin, tenantId, "addon.customer_campaigns", false, admin, "off");
    expect((await row(tenantId, "addon.customer_campaigns"))?.isActive).toBe(false);
    await expect(setTenantAddon(pools.admin, tenantId, "addon.customer_campaigns", true, admin, null)).rejects.toThrow("addon_not_released");
    expect((await row(tenantId, "addon.customer_campaigns"))?.isActive).toBe(false);
  });
});
