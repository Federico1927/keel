import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const MIN = 60_000;
const DAY = 864e5;

interface RunSpec {
  queue: string;
  jobType: string;
  trigger?: string;
  at: Date;
  ms: number;
  rows?: number | null;
  error?: string;
}

const row = (tenantId: string | null, r: RunSpec) => ({ tenantId, queue: r.queue, jobType: r.jobType, trigger: r.trigger ?? (r.queue === "scheduler.tick" ? "schedule" : "queue"), status: r.error ? "failed" : "succeeded", startedAt: r.at, finishedAt: new Date(r.at.getTime() + r.ms), durationMs: r.ms, rows: r.error ? null : (r.rows ?? null), error: r.error ?? null, summary: { seed: true } });
const seeded = sql`${schema.jobRuns.summary}->>'seed' = 'true'`;

/**
 * Reliability history of one demo tenant (#32): a few days of job runs (15-minute order deltas,
 * daily ads pulls, nightly catalog and audit retention), a payouts job that failed three times last
 * week and recovered (resolved alert), a Google source that went stale for a few hours (resolved),
 * an expired full data export and, on Northwind, a Google source that is currently idle (the
 * dashboard widget has something to show). Deterministic; only seeded rows are replaced.
 */
export async function seedReliability(db: Db, key: "northwind" | "harbor", tenantId: string, ownerId: string | null, now: Date): Promise<void> {
  await db.delete(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, tenantId), seeded));
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * MIN);
  const runs: RunSpec[] = [];
  for (let i = 0; i < 24; i++) runs.push({ queue: "sync.orders", jobType: "sync.orders", at: at(5 + i * 15), ms: 1800 + ((i * 937) % 3200), rows: (i * 7 + (key === "northwind" ? 11 : 3)) % 23 });
  for (let d = 0; d < 7; d++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - d));
    runs.push({ queue: "sync.ads", jobType: "sync.ads:meta", at: new Date(day.getTime() + 6 * 60 * MIN + 30_000), ms: 8000 + d * 310, rows: key === "northwind" ? 310 + d : 120 + d });
    runs.push({ queue: "sync.ads", jobType: "sync.ads:google", at: new Date(day.getTime() + 6 * 60 * MIN + 45_000), ms: 5200 + d * 170, rows: key === "northwind" && d < 3 ? 0 : 60 + d });
    runs.push({ queue: "sync.catalog", jobType: "sync.catalog", at: new Date(day.getTime() + 3 * 60 * MIN + 20_000), ms: 21_000 + d * 900, rows: 40 + d });
    if (d < 3) runs.push({ queue: "scheduler.tick", jobType: "audit.retention", at: new Date(day.getTime() + (4 * 60 + 10) * MIN), ms: 120 + d * 9, rows: 0 });
  }
  // payouts: three failures in a row last week, then back to normal
  for (let i = 0; i < 3; i++) runs.push({ queue: "sync.payouts", jobType: "sync.payouts", at: new Date(now.getTime() - (8 * DAY + (2 - i) * 40 * MIN)), ms: 900 + i * 50, error: "Rate limited by the platform (429), retry after 40s" });
  for (let d = 0; d < 7; d++) runs.push({ queue: "sync.payouts", jobType: "sync.payouts", at: new Date(now.getTime() - d * DAY - 3 * 60 * MIN), ms: 3100 + d * 120, rows: 12 + d });
  await db.insert(schema.jobRuns).values(runs.map((r) => row(tenantId, r)));

  const alerts = [
    { signature: `job_failure:${tenantId}:sync.payouts`, kind: "job_failure", subject: "sync.payouts", occurrences: 3, lastError: "Rate limited by the platform (429), retry after 40s", firstSeenAt: new Date(now.getTime() - 8 * DAY - 80 * MIN), lastSeenAt: new Date(now.getTime() - 8 * DAY), lastNotifiedAt: new Date(now.getTime() - 8 * DAY), resolvedAt: new Date(now.getTime() - 7 * DAY - 21 * 60 * MIN) },
    { signature: `sync_stale:${tenantId}:google`, kind: "sync_stale", subject: "google", occurrences: 4, lastError: null, firstSeenAt: new Date(now.getTime() - 3 * DAY - 5 * 60 * MIN), lastSeenAt: new Date(now.getTime() - 3 * DAY - 4.5 * 60 * MIN), lastNotifiedAt: new Date(now.getTime() - 3 * DAY - 5 * 60 * MIN), resolvedAt: new Date(now.getTime() - 3 * DAY - 4 * 60 * MIN) },
  ];
  await db.delete(schema.platformAlerts).where(inArray(schema.platformAlerts.signature, alerts.map((a) => a.signature)));
  await db.insert(schema.platformAlerts).values(alerts.map((a) => ({ tenantId, ...a, status: "resolved", notifiedCount: 1, resolvedBy: "auto", meta: { seed: true } })));

  await db.delete(schema.tenantDataExports).where(eq(schema.tenantDataExports.tenantId, tenantId));
  const created = new Date(now.getTime() - 40 * DAY);
  const tables = key === "northwind" ? { orders: 15012, order_lines: 27421, customers: 8650, products: 120 } : { orders: 6020, order_lines: 9011, customers: 3712, products: 60 };
  await db.insert(schema.tenantDataExports).values({ tenantId, requestedBy: ownerId, requestedByType: "owner", status: "expired", tables, rowCount: Object.values(tables).reduce((a, b) => a + b, 0), fileName: `${key}-data-${created.toISOString().slice(0, 10)}.zip`, sizeBytes: key === "northwind" ? 9_840_000 : 3_120_000, createdAt: created, completedAt: new Date(created.getTime() + 3 * MIN), expiresAt: new Date(created.getTime() + 7 * DAY), downloadedAt: new Date(created.getTime() + 20 * MIN), downloadCount: 1, updatedAt: new Date(created.getTime() + 7 * DAY) });

  // Northwind's Google pull has written nothing for three runs: idle (the dashboard widget shows it)
  if (key === "northwind") await db.update(schema.integrationHealth).set({ status: "idle", zeroRowRuns: 3, rowsWrittenLast: 0, watchdogNotifiedAt: new Date(now.getTime() - 2 * 60 * MIN) }).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "google")));
}

/**
 * Platform side (#32): scheduler ticks of the last hours (one billing run failed two days ago) and,
 * on the console tenant whose integrations are broken (Coral Beauty), an open failing-job alert and
 * an open stale-source alert with their failed runs.
 */
export async function seedPlatformReliability(db: Db, consoleTenantIds: Record<string, string>, now: Date): Promise<void> {
  await db.delete(schema.jobRuns).where(and(isNull(schema.jobRuns.tenantId), seeded));
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * MIN);
  const ticks: RunSpec[] = [];
  for (let i = 0; i < 24; i++) ticks.push({ queue: "scheduler.tick", jobType: "tick:delta", at: at(6 + i * 15), ms: 140 + ((i * 53) % 90), rows: null });
  for (let i = 0; i < 12; i++) ticks.push({ queue: "scheduler.tick", jobType: "tick:watchdog", at: at(9 + i * 10), ms: 220 + ((i * 31) % 120), rows: 1 });
  for (let i = 0; i < 6; i++) ticks.push({ queue: "scheduler.tick", jobType: "tick:alerts", at: at(40 + i * 60), ms: 1900 + i * 80, rows: null });
  for (let i = 0; i < 6; i++) ticks.push({ queue: "scheduler.tick", jobType: "tick:emails", at: at(7 + i * 10), ms: 60 + i * 7, rows: null });
  for (let d = 0; d < 3; d++) {
    ticks.push({ queue: "scheduler.tick", jobType: "tick:retention", at: at(d * 1440 + 300), ms: 2400 + d * 100, rows: 180 + d * 7 });
    ticks.push({ queue: "scheduler.tick", jobType: "tick:billing", at: at(d * 1440 + 200), ms: 1300 + d * 40, ...(d === 2 ? { error: "Billing provider timed out after 30s" } : { rows: null }) });
  }
  await db.insert(schema.jobRuns).values(ticks.map((r) => row(null, r)));
  const coral = consoleTenantIds["coral-beauty"];
  if (!coral) return;
  await db.delete(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, coral), seeded));
  const failing: RunSpec[] = [0, 1, 2, 3].map((i) => ({ queue: "sync.ads", jobType: "sync.ads:meta", at: at(30 + i * 60), ms: 700 + i * 20, error: "Meta access token expired: reconnect the account" }));
  failing.push({ queue: "sync.ads", jobType: "sync.ads:meta", at: at(2 * 1440), ms: 7400, rows: 96 });
  await db.insert(schema.jobRuns).values(failing.map((r) => row(coral, r)));
  const alerts = [
    { signature: `job_failure:${coral}:sync.ads:meta`, kind: "job_failure", subject: "sync.ads:meta", occurrences: 2, lastError: "Meta access token expired: reconnect the account", firstSeenAt: at(150), lastSeenAt: at(30), lastNotifiedAt: at(150) },
    { signature: `sync_stale:${coral}:shopify`, kind: "sync_stale", subject: "shopify", occurrences: 18, lastError: null, firstSeenAt: at(3 * 1440), lastSeenAt: at(9), lastNotifiedAt: at(4 * 60) },
  ];
  await db.delete(schema.platformAlerts).where(inArray(schema.platformAlerts.signature, alerts.map((a) => a.signature)));
  await db.insert(schema.platformAlerts).values(alerts.map((a) => ({ tenantId: coral, ...a, status: "open", notifiedCount: a.kind === "sync_stale" ? 12 : 1, meta: { seed: true } })));
}
