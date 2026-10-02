import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedPlatform, type SeedContext } from "@keel/db/seed";
import { mrr } from "@keel/core";
import { PLANS, type PlanKey } from "@keel/config";
import {
  AdminUserError,
  LifecycleError,
  adminInvoiceList,
  adminTenantList,
  adminUserDetail,
  drainEmailJobs,
  getAccountProfile,
  invoicesCsv,
  mockEmailOutbox,
  platformSeriesReport,
  refreshTenantPaymentState,
  requestPasswordReset,
  revokeUserSessions,
  setTenantPlan,
  setTrialEnd,
  setUserDisabled,
  tenantsCsv,
  tenantsOverview,
  transitionTenant,
  userDirectory,
  planUsage,
  integrationIssues,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let admin = "";
const db = () => pools.admin;
const audit = (action: string, entityId: string) => db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.entityId, entityId))).orderBy(desc(schema.auditLogs.createdAt));
const tenantBySlug = async (slug: string) => (await db().select().from(schema.tenants).where(eq(schema.tenants.slug, slug)))[0]!;

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  admin = ctx.userIds["superadmin@keel.demo"]!;
});
afterAll(() => pools.close());

describe("users directory (#48)", () => {
  it("finds a user by part of the email or the name, with tenants and roles", async () => {
    const byEmail = await userDirectory(db(), { q: "care2@north" });
    expect(byEmail.rows.map((r) => r.email)).toEqual(["care2@northwind.demo"]);
    expect(byEmail.rows[0]!.memberships).toEqual([expect.objectContaining({ tenantName: "Northwind Apparel", role: "customer_care", isActive: true })]);
    const byName = await userDirectory(db(), { q: "alex multi" });
    expect(byName.rows[0]!.memberships.map((m) => m.tenantName).sort()).toEqual(["Harbor Home", "Northwind Apparel"]);
    const supers = await userDirectory(db(), { kind: "super_admin" });
    expect(supers.rows.every((r) => r.isSuperAdmin)).toBe(true);
    const disabled = await userDirectory(db(), { kind: "disabled" });
    expect(disabled.rows.map((r) => r.email)).toContain("ex.manager@delta-gear.demo");
    const harbor = await userDirectory(db(), { tenantId: ctx.tenantIds.harbor, sort: "email" });
    expect(harbor.rows.map((r) => r.email)).toEqual([...harbor.rows.map((r) => r.email)].sort());
    expect(harbor.rows.map((r) => r.email)).toContain("owner@harborhome.demo");
  });

  it("disables a user: sessions end, sign-in data refused, reset not sent, notice queued, audited; then enables", async () => {
    const userId = ctx.userIds["care2@northwind.demo"]!;
    const before = (await getAccountProfile(db(), userId))!;
    await expect(setUserDisabled(db(), { userId: admin, disabled: true, actorUserId: admin })).rejects.toBeInstanceOf(AdminUserError);
    expect(await setUserDisabled(db(), { userId, disabled: true, reason: "Left the team", actorUserId: admin })).toEqual({ changed: true });
    const after = (await getAccountProfile(db(), userId))!;
    expect(after.disabled).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    const [row] = await audit("user.disabled", userId);
    expect(row).toMatchObject({ actorUserId: admin, actorType: "super_admin", tenantId: null, entityType: "user" });
    expect(row!.metadata).toMatchObject({ reason: "Left the team", email: "care2@northwind.demo" });
    expect((row!.diff as { sessionVersion: { to: number } }).sessionVersion.to).toBe(after.sessionVersion);
    await drainEmailJobs(db());
    expect(mockEmailOutbox().to("care2@northwind.demo").at(-1)?.message.subject).toMatch(/disabled/i);
    expect(await requestPasswordReset(db(), { email: "care2@northwind.demo", requestedBy: admin })).toEqual({ sent: false });
    expect(await setUserDisabled(db(), { userId, disabled: true, actorUserId: admin })).toEqual({ changed: false });
    const detail = (await adminUserDetail(db(), userId))!;
    expect(detail.user.disabledReason).toBe("Left the team");
    expect(detail.disabledByEmail).toBe("superadmin@keel.demo");
    await setUserDisabled(db(), { userId, disabled: false, actorUserId: admin });
    expect((await getAccountProfile(db(), userId))!.disabled).toBe(false);
    expect(await audit("user.enabled", userId)).toHaveLength(1);
  });

  it("revokes sessions with an audited version bump", async () => {
    const userId = ctx.userIds["viewer@northwind.demo"]!;
    const v = (await getAccountProfile(db(), userId))!.sessionVersion;
    expect(await revokeUserSessions(db(), { userId, actorUserId: admin })).toEqual({ sessionVersion: v + 1 });
    expect((await audit("user.sessions_revoked", userId))[0]!.actorType).toBe("super_admin");
  });
});

describe("tenant lifecycle (#48)", () => {
  it("records reason, note, history snapshot and audit; mirrors the subscription; refuses moves not allowed", async () => {
    const t = await tenantBySlug("alpine-outdoor");
    expect(t.status).toBe("trial");
    await expect(transitionTenant(db(), t.id, { to: "trial", reason: "other", actorUserId: admin })).resolves.toEqual({ changed: false, from: "trial" });
    await transitionTenant(db(), t.id, { to: "active", reason: "trial_converted", note: "Signed the annual contract", actorUserId: admin });
    await expect(transitionTenant(db(), t.id, { to: "trial", reason: "other", actorUserId: admin })).rejects.toBeInstanceOf(LifecycleError);
    await transitionTenant(db(), t.id, { to: "suspended", reason: "terms_violation", note: "Reselling accounts", actorUserId: admin, manual: true });
    const suspended = await tenantBySlug("alpine-outdoor");
    expect(suspended).toMatchObject({ status: "suspended", statusReason: "terms_violation", statusNote: "Reselling accounts" });
    expect(suspended.suspendedAt).toBeInstanceOf(Date);
    const [sub] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, t.id));
    expect(sub!.status).toBe("suspended");
    const [a] = await audit("tenant.suspended", t.id);
    expect(a!.diff).toMatchObject({ status: { from: "active", to: "suspended" } });
    expect(a!.metadata).toMatchObject({ reason: "terms_violation", note: "Reselling accounts" });
    const events = await db().select().from(schema.tenantLifecycleEvents).where(eq(schema.tenantLifecycleEvents.tenantId, t.id)).orderBy(desc(schema.tenantLifecycleEvents.createdAt));
    expect(events[0]).toMatchObject({ fromStatus: "active", toStatus: "suspended", reason: "terms_violation", planKey: "growth", monthlyMinor: PLANS.growth.monthlyPriceMinor, actorUserId: admin, actorType: "super_admin" });
    // a manual suspension is not lifted by the billing run
    await refreshTenantPaymentState(db(), t.id, new Date(), null);
    expect((await tenantBySlug("alpine-outdoor")).status).toBe("suspended");
    await transitionTenant(db(), t.id, { to: "churned", reason: "customer_request", note: "Closed", actorUserId: admin });
    const churned = await tenantBySlug("alpine-outdoor");
    expect(churned.churnedAt).toBeInstanceOf(Date);
    expect(churned.suspendedAt).toBeNull();
    const [cancelled] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, t.id));
    expect(cancelled!.status).toBe("cancelled");
  });

  it("the billing run moves past due and back to active with a system reason", async () => {
    const t = await tenantBySlug("coral-beauty");
    const [open] = await db().select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, t.id), eq(schema.invoices.status, "open")));
    const late = new Date(open!.dueAt.getTime() + 3 * 864e5);
    await refreshTenantPaymentState(db(), t.id, late, null);
    expect(await tenantBySlug("coral-beauty")).toMatchObject({ status: "past_due", statusReason: "payment_overdue" });
    await db().update(schema.invoices).set({ status: "paid", paidAt: late }).where(eq(schema.invoices.id, open!.id));
    await refreshTenantPaymentState(db(), t.id, late, null);
    expect(await tenantBySlug("coral-beauty")).toMatchObject({ status: "active", statusReason: "payment_recovered" });
  });

  it("sets the trial end on the tenant and the trialing subscription, audited", async () => {
    const t = await tenantBySlug("harbor-home");
    const end = new Date("2027-01-31T23:59:59Z");
    await setTrialEnd(db(), t.id, end, admin, "extended");
    expect((await tenantBySlug("harbor-home")).trialEndsAt?.toISOString()).toBe(end.toISOString());
    expect((await audit("tenant.trial_end_changed", t.id))[0]!.metadata).toMatchObject({ note: "extended" });
  });

  it("plan changes write a snapshot used by the metrics; MRR by tenant matches its subscription", async () => {
    const nw = ctx.tenantIds.northwind;
    await setTenantPlan(db(), nw, "scale", admin);
    const { months } = await platformSeriesReport(db(), { months: 3 });
    const current = months.at(-1)!;
    const [sub] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, nw));
    const addons = (await db().select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, nw), eq(schema.tenantAddons.isActive, true)))).map((r) => r.k);
    expect(current.mrrByTenant[nw]).toBe(mrr([{ status: sub!.status, planKey: sub!.planKey as PlanKey, addons }]));
    expect(current.active).toContain(nw);
    // churned console tenants are counted in the month they churned, never in MRR afterwards
    const maple = (await tenantBySlug("maple-kids")).id;
    expect(current.mrrByTenant[maple]).toBeUndefined();
    await setTenantPlan(db(), nw, "growth", admin);
  });
});

describe("console tables (#48)", () => {
  it("tenant list: search, lifecycle and attention filters, sort, CSV with audit", async () => {
    const all = await tenantsOverview(db());
    const coral = all.find((x) => x.slug === "coral-beauty")!;
    expect(coral.integrationErrors).toBe(2);
    expect(coral.health.needsAttention).toBe(true);
    const attention = await adminTenantList(db(), { attention: "1" });
    expect(attention.rows.length).toBeGreaterThan(0);
    expect(attention.rows.every((r) => r.health.needsAttention)).toBe(true);
    expect((await adminTenantList(db(), { q: "harbor" })).rows.map((r) => r.slug)).toEqual(["harbor-home"]);
    expect((await adminTenantList(db(), { status: "churned" })).rows.map((r) => r.slug)).toEqual(expect.arrayContaining(["fjord-home", "maple-kids"]));
    const byHealth = (await adminTenantList(db(), { sort: "health", dir: "asc" })).rows.map((r) => r.health.score);
    expect(byHealth).toEqual([...byHealth].sort((a, b) => a - b));
    const csv = await tenantsCsv(db(), { status: "churned" }, admin);
    expect(csv.csv.startsWith("\uFEFFtenant_id,name,slug,status,")).toBe(true);
    const lines = csv.csv.trim().split("\r\n");
    expect(lines).toHaveLength(csv.rows + 1);
    const [row] = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "admin.export_csv"), eq(schema.auditLogs.entityType, "tenants"))).orderBy(desc(schema.auditLogs.createdAt)).limit(1);
    expect(row!.metadata).toMatchObject({ rows: csv.rows, query: { status: "churned" } });
  });

  it("invoice list: status, tenant and search filters, sort by amount, pagination, CSV", async () => {
    const open = await adminInvoiceList(db(), { status: "open" });
    expect(open.rows.every((r) => r.invoice.status === "open")).toBe(true);
    const nw = await adminInvoiceList(db(), { tenant: ctx.tenantIds.northwind, sort: "amount", dir: "desc" });
    const amounts = nw.rows.map((r) => r.invoice.amountMinor);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    expect(nw.rows.every((r) => r.tenantName === "Northwind Apparel")).toBe(true);
    expect((await adminInvoiceList(db(), { q: "delta" })).rows.every((r) => r.tenantSlug === "delta-gear")).toBe(true);
    const paged = await adminInvoiceList(db(), {}, { pageSize: 2 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.total).toBeGreaterThan(2);
    const csv = await invoicesCsv(db(), { tenant: ctx.tenantIds.northwind }, admin);
    expect(csv.rows).toBe(nw.total);
  });

  it("plans view counts tenants per plan and add-on; integration drill-down lists errors per tenant and source", async () => {
    const usage = await planUsage(db());
    expect(usage.plans.map((p) => p.plan.key)).toEqual(["starter", "growth", "scale"]);
    expect(usage.addons.find((a) => a.module.key === "addon.cod")!.tenants).toBeGreaterThanOrEqual(1);
    const issues = await integrationIssues(db(), { source: "shopify" });
    expect(issues.rows.some((r) => r.tenantSlug === "coral-beauty")).toBe(true);
  });
});
