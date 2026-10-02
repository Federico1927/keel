import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, isNull, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import type { MockAdsPlatform } from "@keel/integrations";
import { failureAlertSignature, parseTenantSettings } from "@keel/core";
import { TenantExportError, auditFilterConditions, emailIdempotencyKey, getAdsPlatformFor, listPlatformAlerts, parseAuditFilters, platformAlertSink, purgeExpiredAudit, purgeExpiredTenantExports, raisePlatformAlert, requestTenantExport, runAdsSync, runTenantExport, runWatchdog, sourcesNeedingAttention, takeTenantExportFile, tenantsOverview, trackJobRun, unzipFiles, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let harbor = "";
let northwind = "";
const db = () => pools.admin;
const runIn = <T>(tenantId: string, fn: (s: ServiceContext) => Promise<T>, now?: Date) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null }, now }), pools.app);
const runner = <T>(tenantId: string, fn: (tx: ServiceContext["tx"]) => Promise<T>) => withTenant(tenantId, fn, pools.app);

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  harbor = ctx.tenantIds.harbor;
  northwind = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());

describe("integration watchdog (#32)", () => {
  it("mock Meta failing: stale after the freshness window, one resync, exactly one owner notification in 6 hours", async () => {
    const T0 = new Date("2026-09-01T08:00:00Z");
    const at = (min: number) => new Date(T0.getTime() + min * 60_000);
    const tenant = { id: harbor, currency: "USD", country: "US", orderNumberPrefix: "" };
    const settings = parseTenantSettings((await db().select({ s: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, harbor)))[0]!.s);
    const owner = ctx.userIds["owner@harborhome.demo"]!;
    // a healthy pull at T0, then the mock adapter fails every call
    const ok = await runIn(harbor, async (s) => runAdsSync(s, await getAdsPlatformFor(s, tenant, "meta"), { since: "2026-08-29", until: "2026-09-01" }), T0);
    expect(ok.error).toBeNull();
    const mock = (await runIn(harbor, (s) => getAdsPlatformFor(s, tenant, "meta"))) as MockAdsPlatform;
    mock.failures.failNext("token_expired", 200);
    const health = async () => (await db().select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, harbor), eq(schema.integrationHealth.source, "meta"))))[0]!;
    const notifications = () => db().select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, harbor), eq(schema.notifications.userId, owner), eq(schema.notifications.type, "sync_delay"), eq(schema.notifications.link, "/integrations#meta")));
    const before = (await notifications()).length;

    let resyncs = 0;
    const tick = async (min: number) => {
      const r = await runIn(harbor, (s) => runWatchdog(s, settings), at(min));
      resyncs += r.resync.length;
      return r;
    };
    // inside the window (Meta: 120 minutes) a failure is only "degraded"
    const failed = await runIn(harbor, async (s) => runAdsSync(s, await getAdsPlatformFor(s, tenant, "meta"), { since: "2026-08-29", until: "2026-09-01" }), at(60));
    expect(failed.error).toMatch(/token expired/i);
    expect((await health()).status).toBe("degraded");
    expect((await tick(60)).stale).toEqual([]);
    // past the window: stale (recordHealth and the watchdog agree), one resync
    await runIn(harbor, async (s) => runAdsSync(s, await getAdsPlatformFor(s, tenant, "meta"), { since: "2026-08-29", until: "2026-09-01" }), at(130));
    expect((await health()).status).toBe("stale");
    const first = await tick(130);
    expect(first.stale.map((x) => x.source)).toEqual(["meta"]);
    expect(first.resync.map((x) => x.source)).toEqual(["meta"]);
    // ticks every 10 minutes for 6 hours: no second resync, one notification (once late beyond the tenant's grace)
    for (let m = 140; m <= 130 + 6 * 60; m += 10) await tick(m);
    expect(resyncs).toBe(1);
    expect((await notifications()).length - before).toBe(1);
    expect((await health()).status).toBe("stale");
    // after 6 hours the reminder goes out again
    await tick(130 + 6 * 60 + 70);
    expect((await notifications()).length - before).toBe(2);
    expect(resyncs).toBe(1);
    // audited resync request
    const audits = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), eq(schema.auditLogs.action, "integration.watchdog_resync")));
    expect(audits).toHaveLength(1);
    // the source recovers: ok again, and the next stale episode gets a new resync
    while (mock.failures.pending) await mock.testConnection().catch(() => undefined);
    await runIn(harbor, async (s) => runAdsSync(s, await getAdsPlatformFor(s, tenant, "meta"), { since: "2026-08-29", until: "2026-09-01" }), at(900));
    expect((await health()).status).toBe("ok");
    expect((await tick(900)).stale).toEqual([]);
    const later = await tick(900 + 200);
    expect(later.resync.map((x) => x.source)).toEqual(["meta"]);
  });

  it("idle after N successful runs without rows; the dashboard widget counts the sources that are not OK", async () => {
    const w = await runIn(northwind, (s) => sourcesNeedingAttention(s));
    expect(w.total).toBeGreaterThanOrEqual(3);
    expect(w.problems.map((p) => [p.source, p.status])).toContainEqual(["google", "idle"]);
    const settings = parseTenantSettings((await db().select({ s: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, northwind)))[0]!.s);
    const r = await runIn(northwind, (s) => runWatchdog(s, settings));
    expect(r.idle.map((x) => x.source)).toContain("google");
    // the seed told the owners 2 hours ago: nothing new inside the 6 hours
    expect(r.notified).not.toContain("google");
  });

  it("platform alerts are deduplicated per signature per window", async () => {
    const T = new Date("2026-09-02T10:00:00Z");
    const sink = platformAlertSink();
    const sent = sink.sent.length;
    const input = { kind: "sync_stale" as const, tenantId: harbor, subject: "meta", meta: { minutesLate: 200 } };
    const a = await raisePlatformAlert(db(), { ...input, now: T }, { notifyTenant: false, runInTenant: runner });
    const b = await raisePlatformAlert(db(), { ...input, now: new Date(T.getTime() + 3600e3) }, { notifyTenant: false, runInTenant: runner });
    expect(a.notified).toBe(true);
    expect(b).toMatchObject({ id: a.id, notified: false, occurrences: 2 });
    expect(sink.sent.length - sent).toBe(1);
    const supers = await db().select({ email: schema.users.email }).from(schema.users).where(and(eq(schema.users.isSuperAdmin, true), isNull(schema.users.disabledAt)));
    const keys = supers.map((u) => emailIdempotencyKey(null, "notification", u.email, `platform_alert:${a.id}:1`));
    const emails = await db().select().from(schema.emailMessages).where(and(isNull(schema.emailMessages.tenantId), eq(schema.emailMessages.category, "platform_failure"), inArray(schema.emailMessages.idempotencyKey, keys)));
    expect(supers.length).toBeGreaterThan(0);
    expect(emails).toHaveLength(supers.length);
    const c = await raisePlatformAlert(db(), { ...input, now: new Date(T.getTime() + 6 * 3600e3) }, { notifyTenant: false, runInTenant: runner });
    expect(c.notified).toBe(true);
    const list = await listPlatformAlerts(db(), { status: "open", tenantId: harbor });
    expect(list.rows.filter((r) => r.alert.signature === failureAlertSignature("sync_stale", harbor, "meta"))).toHaveLength(1);
  });
});

describe("job run history and failure alerts (#32)", () => {
  it("records status, duration and rows; N failures in a row raise one alert to super-admins and owners; a success resolves it", async () => {
    const input = { queue: "sync.payouts", jobType: "sync.payouts:test", tenantId: harbor };
    const r = await trackJobRun(db(), input, async () => ({ rows: 17, summary: { pages: 2 } }), { runInTenant: runner });
    expect(r).toEqual({ rows: 17, summary: { pages: 2 } });
    const [ok] = await db().select().from(schema.jobRuns).where(eq(schema.jobRuns.jobType, "sync.payouts:test")).orderBy(desc(schema.jobRuns.startedAt)).limit(1);
    expect(ok).toMatchObject({ status: "succeeded", rows: 17, tenantId: harbor, trigger: "queue" });
    expect(ok!.durationMs).toBeGreaterThanOrEqual(0);
    const owner = ctx.userIds["owner@harborhome.demo"]!;
    const ownerAlerts = () => db().select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, harbor), eq(schema.notifications.userId, owner), eq(schema.notifications.type, "platform_failure")));
    const fail = () => trackJobRun(db(), input, async () => { throw new Error("Rate limited (429)"); }, { runInTenant: runner, log: () => {} }).catch((e: Error) => e.message);
    expect(await fail()).toBe("Rate limited (429)");
    expect(await fail()).toBe("Rate limited (429)");
    const sig = failureAlertSignature("job_failure", harbor, "sync.payouts:test");
    expect(await db().select().from(schema.platformAlerts).where(eq(schema.platformAlerts.signature, sig))).toHaveLength(0);
    await fail();
    await fail();
    const [alert] = await db().select().from(schema.platformAlerts).where(eq(schema.platformAlerts.signature, sig));
    expect(alert).toMatchObject({ status: "open", kind: "job_failure", occurrences: 2, notifiedCount: 1, lastError: "Rate limited (429)" });
    expect(await ownerAlerts()).toHaveLength(1);
    const runs = await db().select().from(schema.jobRuns).where(and(eq(schema.jobRuns.jobType, "sync.payouts:test"), eq(schema.jobRuns.status, "failed")));
    expect(runs).toHaveLength(4);
    expect(runs.every((x) => x.error === "Rate limited (429)" && x.finishedAt)).toBe(true);
    await trackJobRun(db(), input, async () => undefined, { runInTenant: runner });
    const [resolved] = await db().select().from(schema.platformAlerts).where(eq(schema.platformAlerts.signature, sig));
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "auto" });
    // the console's tenant health counts failed job runs of the last 7 days
    const overview = await tenantsOverview(db());
    expect(overview.find((t) => t.id === harbor)!.failedJobs).toBeGreaterThanOrEqual(4);
  });
});

describe("tenant data export (#32)", () => {
  it("contains every tenant table for tenant A only: no row of tenant B, no secrets; the link expires", async () => {
    const owner = ctx.userIds["owner@northwind.demo"]!;
    const exportId = await runIn(northwind, (s) => requestTenantExport(s, { userId: owner }));
    await expect(runIn(northwind, (s) => requestTenantExport(s, { userId: owner }))).rejects.toBeInstanceOf(TenantExportError);
    const r = await runIn(northwind, (s) => runTenantExport(s, exportId));
    expect(r.status).toBe("done");
    expect(r.tables).toBeGreaterThan(80);
    const { file } = await runIn(northwind, (s) => takeTenantExportFile(s.tx, northwind, exportId, { userId: owner, actorType: "user" }));
    const files = unzipFiles(file);
    const names = files.map((f) => f.name);
    expect(names).toContain("manifest.json");
    expect(names).toEqual(expect.arrayContaining(["orders.csv", "customers.csv", "order_lines.csv", "audit_logs.csv", "integrations.csv"]));
    expect(names).not.toContain("tenant_data_exports.csv");
    let checkedRows = 0;
    for (const f of files.filter((x) => x.name.endsWith(".csv"))) {
      const text = f.data.toString("utf8");
      // no value of tenant B anywhere in the archive
      expect(text.includes(harbor), `${f.name} mentions tenant B`).toBe(false);
      const lines = text.replace(/^\uFEFF/, "").trimEnd().split("\n");
      const tenantCol = lines[0]!.split(",").indexOf("tenant_id");
      expect(tenantCol, `${f.name} has a tenant_id column`).toBeGreaterThanOrEqual(0);
      for (const line of lines.slice(1)) {
        if (!line.includes(northwind)) continue;
        checkedRows++;
      }
    }
    expect(checkedRows).toBeGreaterThan(1000);
    const orders = files.find((f) => f.name === "orders.csv")!.data.toString("utf8").trimEnd().split("\n").length - 1;
    const [count] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(eq(schema.orders.tenantId, northwind));
    expect(orders).toBe(count!.n);
    const manifest = JSON.parse(files.find((f) => f.name === "manifest.json")!.data.toString("utf8")) as { tenant: { id: string }; tables: Record<string, number>; excludedColumns: string[] };
    expect(manifest.tenant.id).toBe(northwind);
    expect(manifest.tables.orders).toBe(count!.n);
    expect(manifest.excludedColumns).toEqual(expect.arrayContaining(["integrations.credentials_encrypted", "invitations.token_hash", "tenant_branding.logo_light_data", "list_exports.content"]));
    expect(files.find((f) => f.name === "integrations.csv")!.data.toString("utf8").split("\n")[0]).not.toContain("credentials_encrypted");
    // audited request, completion and download
    const actions = (await db().select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, northwind), eq(schema.auditLogs.entityId, exportId)))).map((a) => a.action).sort();
    expect(actions).toEqual(["tenant.data_export_completed", "tenant.data_export_downloaded", "tenant.data_export_requested"]);
    // tenant B cannot see it
    expect(await withTenant(harbor, (tx) => tx.select().from(schema.tenantDataExports).where(eq(schema.tenantDataExports.id, exportId)), pools.app)).toHaveLength(0);
    await expect(runIn(harbor, (s) => takeTenantExportFile(s.tx, northwind, exportId, { userId: owner, actorType: "user" }))).rejects.toMatchObject({ code: "not_found" });
    // the link expires, then the file is deleted
    const later = new Date(Date.now() + 8 * 864e5);
    await expect(runIn(northwind, (s) => takeTenantExportFile(s.tx, northwind, exportId, { userId: owner, actorType: "user" }, later))).rejects.toMatchObject({ code: "expired" });
    expect(await purgeExpiredTenantExports(db(), later)).toBeGreaterThanOrEqual(1);
    const [row] = await db().select().from(schema.tenantDataExports).where(eq(schema.tenantDataExports.id, exportId));
    expect(row).toMatchObject({ status: "expired", file: null, downloadCount: 1 });
  });
});

describe("audit retention and viewer filters (#32)", () => {
  it("deletes rows past the plan's window in batches, with a run record", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 864e5);
    const recent = new Date(now.getTime() - 30 * 864e5);
    await db().execute(sql`insert into audit_logs (tenant_id, actor_type, action, entity_type, entity_id, created_at) select ${harbor}::uuid, 'system', 'test.old', 'order', 'o-' || g, ${old} from generate_series(1, 2500) g`);
    await db().insert(schema.auditLogs).values({ tenantId: harbor, actorType: "system", action: "test.recent", entityType: "order", entityId: "o-recent", createdAt: recent });
    const [res] = await purgeExpiredAudit(db(), { now, batchSize: 1000, tenantIds: [harbor] });
    // other suites may leave old audit rows of their own: the batches follow what was actually deleted
    expect(res).toMatchObject({ tenantId: harbor, retentionDays: 180, batches: Math.ceil(res!.deleted / 1000) });
    expect(res!.deleted).toBeGreaterThanOrEqual(2500);
    const left = await db().select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), sql`${schema.auditLogs.action} like 'test.%'`));
    expect(left.map((l) => l.action)).toEqual(["test.recent"]);
    const [run] = await db().select().from(schema.jobRuns).where(and(eq(schema.jobRuns.jobType, "audit.retention"), eq(schema.jobRuns.tenantId, harbor), sql`${schema.jobRuns.summary}->>'seed' is null`)).orderBy(desc(schema.jobRuns.startedAt)).limit(1);
    expect(run).toMatchObject({ status: "succeeded", rows: res!.deleted });
    expect(run!.summary).toMatchObject({ batches: res!.batches, retentionDays: 180 });
    const [trace] = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), eq(schema.auditLogs.action, "audit.retention_purged")));
    expect(trace!.metadata).toMatchObject({ deleted: res!.deleted, batches: res!.batches });
    // a second run finds nothing and still leaves its record
    const [again] = await purgeExpiredAudit(db(), { now, batchSize: 1000, tenantIds: [harbor] });
    expect(again).toMatchObject({ deleted: 0, batches: 0 });
  });

  it("filters by actor, entity, record and date", async () => {
    const owner = ctx.userIds["owner@harborhome.demo"]!;
    await db().insert(schema.auditLogs).values([
      { tenantId: harbor, actorUserId: owner, actorType: "user", action: "filter.a", entityType: "purchase_order", entityId: "po-1", createdAt: new Date("2026-03-10T23:30:00Z") },
      { tenantId: harbor, actorUserId: owner, actorType: "user", action: "filter.b", entityType: "purchase_order", entityId: "po-2", createdAt: new Date("2026-03-12T10:00:00Z") },
      { tenantId: harbor, actorType: "system", action: "filter.c", entityType: "return", entityId: "po-1", createdAt: new Date("2026-03-12T11:00:00Z") },
    ]);
    const find = async (q: Record<string, string>, timezone = "UTC") => (await db().select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), sql`${schema.auditLogs.action} like 'filter.%'`, ...auditFilterConditions(parseAuditFilters(q), { timezone }))).orderBy(schema.auditLogs.action)).map((r) => r.action);
    expect(await find({ actor_id: owner })).toEqual(["filter.a", "filter.b"]);
    expect(await find({ entity_type: "purchase_order", entity: "po-1" })).toEqual(["filter.a"]);
    expect(await find({ entity: "po-1" })).toEqual(["filter.a", "filter.c"]);
    expect(await find({ from: "2026-03-11", to: "2026-03-12" })).toEqual(["filter.b", "filter.c"]);
    // whole days in the viewer's time zone: 23:30 UTC on the 10th is the 11th in Rome
    expect(await find({ from: "2026-03-11", to: "2026-03-11" }, "Europe/Rome")).toEqual(["filter.a"]);
    expect(await find({ actor: "owner@harbor", actor_type: "user" })).toEqual(["filter.a", "filter.b"]);
  });
});
