import { and, desc, eq, gte, inArray, lt, schema, sql, type Database, type DbExecutor, type SQL } from "@hullwise/db";
import { JOB_FAILURES_BEFORE_ALERT } from "@hullwise/config";
import { failedInARow, failureAlertSignature } from "@hullwise/core";
import { raisePlatformAlert, resolvePlatformAlert, type TenantTxRunner } from "./alerts";

/**
 * Job run history (#32). The worker wraps every handler in `trackJobRun`: one `job_runs` row with
 * status, duration, rows and error; a job type failing N runs in a row for the same tenant raises a
 * platform failure alert, the next success resolves it. Recording never breaks the job itself.
 */
export type JobTrigger = "schedule" | "queue" | "manual" | "inline";

export interface JobRunInput {
  queue: string;
  jobType: string;
  tenantId: string | null;
  trigger?: JobTrigger;
  requestedBy?: string | null;
}

/** What a handler may report back: rows written or deleted, and a small summary. */
export interface JobOutcome {
  rows?: number;
  summary?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

export async function startJobRun(db: DbExecutor, input: JobRunInput, now = new Date()): Promise<string> {
  const [row] = await db.insert(schema.jobRuns).values({ tenantId: input.tenantId && UUID.test(input.tenantId) ? input.tenantId : null, queue: input.queue, jobType: input.jobType, trigger: input.trigger ?? "queue", status: "running", startedAt: now, requestedBy: input.requestedBy ?? null }).returning({ id: schema.jobRuns.id });
  return row!.id;
}

export async function finishJobRun(db: DbExecutor, id: string, r: { status: "succeeded" | "failed"; startedAt: Date; rows?: number | null; error?: string | null; summary?: Record<string, unknown> }, now = new Date()): Promise<void> {
  await db.update(schema.jobRuns).set({ status: r.status, finishedAt: now, durationMs: Math.max(0, now.getTime() - r.startedAt.getTime()), rows: r.rows ?? null, error: r.error ?? null, summary: r.summary ?? {} }).where(eq(schema.jobRuns.id, id));
}

function outcomeOf(v: unknown): JobOutcome {
  if (!v || typeof v !== "object") return {};
  const o = v as JobOutcome;
  return { rows: typeof o.rows === "number" ? o.rows : undefined, summary: o.summary && typeof o.summary === "object" ? o.summary : undefined };
}

/**
 * Runs `fn` and records it. A failure is recorded, checked against the alert threshold and rethrown
 * (pg-boss keeps its retry policy); a success closes the open job alert of the same signature.
 */
export async function trackJobRun<T>(db: Database, input: JobRunInput, fn: () => Promise<T>, opts: { runInTenant?: TenantTxRunner; log?: (msg: string, e: unknown) => void } = {}): Promise<T> {
  const log = opts.log ?? ((msg, e) => console.error(`[jobs] ${msg}`, e));
  const startedAt = new Date();
  let id: string | null = null;
  try {
    id = await startJobRun(db, input, startedAt);
  } catch (e) {
    log("could not record the job run", e);
  }
  try {
    const result = await fn();
    if (id) {
      const o = outcomeOf(result);
      await finishJobRun(db, id, { status: "succeeded", startedAt, rows: o.rows, summary: o.summary }).catch((e: unknown) => log("could not finish the job run", e));
      await resolvePlatformAlert(db, failureAlertSignature("job_failure", input.tenantId, input.jobType)).catch((e: unknown) => log("could not resolve the job alert", e));
    }
    return result;
  } catch (err) {
    if (id) {
      await finishJobRun(db, id, { status: "failed", startedAt, error: errText(err) }).catch((e: unknown) => log("could not finish the job run", e));
      await checkJobFailures(db, input, errText(err), { runInTenant: opts.runInTenant }).catch((e: unknown) => log("could not check the job alert", e));
    }
    throw err;
  }
}

/** The last N runs of this job type and tenant all failed → one deduplicated platform alert. */
export async function checkJobFailures(db: Database, input: Pick<JobRunInput, "jobType" | "tenantId">, error: string, opts: { now?: Date; runInTenant?: TenantTxRunner } = {}): Promise<boolean> {
  const tenantCond = input.tenantId ? eq(schema.jobRuns.tenantId, input.tenantId) : sql`${schema.jobRuns.tenantId} is null`;
  const last = await db.select({ status: schema.jobRuns.status }).from(schema.jobRuns).where(and(eq(schema.jobRuns.jobType, input.jobType), tenantCond, inArray(schema.jobRuns.status, ["succeeded", "failed"]))).orderBy(desc(schema.jobRuns.startedAt)).limit(JOB_FAILURES_BEFORE_ALERT);
  if (!failedInARow(last.map((r) => r.status), JOB_FAILURES_BEFORE_ALERT)) return false;
  await raisePlatformAlert(db, { kind: "job_failure", tenantId: input.tenantId, subject: input.jobType, error, now: opts.now }, { runInTenant: opts.runInTenant });
  return true;
}

/* ---------- console ---------- */

export interface JobRunFilters {
  jobType?: string;
  tenantId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The console's job page: the latest run per job type and tenant (with failures of the last 24
 * hours), and the full history with filters and pagination.
 */
export async function jobRunsOverview(db: DbExecutor, f: JobRunFilters = {}, now = new Date()) {
  const j = schema.jobRuns;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, f.pageSize ?? 50);
  const conds: SQL[] = [];
  if (f.jobType) conds.push(eq(j.jobType, f.jobType));
  if (f.tenantId === "platform") conds.push(sql`${j.tenantId} is null`);
  else if (f.tenantId && UUID.test(f.tenantId)) conds.push(eq(j.tenantId, f.tenantId));
  // the latest-run table follows the job type and tenant filters; the status filter narrows the history only
  const latestConds = [gte(j.startedAt, new Date(now.getTime() - 30 * 864e5)), ...conds];
  if (f.status && ["running", "succeeded", "failed"].includes(f.status)) conds.push(eq(j.status, f.status));
  const where = conds.length ? and(...conds) : undefined;
  const day = new Date(now.getTime() - 864e5);
  const [latest, failures, rows, [count], types] = await Promise.all([
    db.selectDistinctOn([j.jobType, j.tenantId], { run: j, tenantName: schema.tenants.name }).from(j).leftJoin(schema.tenants, eq(schema.tenants.id, j.tenantId)).where(and(...latestConds)).orderBy(j.jobType, j.tenantId, desc(j.startedAt)),
    db.select({ jobType: j.jobType, tenantId: j.tenantId, n: sql<number>`count(*)::int` }).from(j).where(and(eq(j.status, "failed"), gte(j.startedAt, day))).groupBy(j.jobType, j.tenantId),
    db.select({ run: j, tenantName: schema.tenants.name, requestedByEmail: schema.users.email }).from(j).leftJoin(schema.tenants, eq(schema.tenants.id, j.tenantId)).leftJoin(schema.users, eq(schema.users.id, j.requestedBy)).where(where).orderBy(desc(j.startedAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(j).where(where),
    db.selectDistinct({ jobType: j.jobType }).from(j).orderBy(j.jobType),
  ]);
  const failedOf = (jobType: string, tenantId: string | null) => failures.find((x) => x.jobType === jobType && x.tenantId === tenantId)?.n ?? 0;
  return {
    latest: latest.map((l) => ({ ...l, failed24h: failedOf(l.run.jobType, l.run.tenantId) })).sort((a, b) => b.failed24h - a.failed24h || a.run.jobType.localeCompare(b.run.jobType) || (a.tenantName ?? "").localeCompare(b.tenantName ?? "")),
    rows,
    total: count?.n ?? 0,
    page,
    pageSize,
    jobTypes: types.map((t) => t.jobType),
  };
}

/** Failed runs per tenant over the last days: the "failed jobs" factor of the console's tenant health. */
export async function failedJobsByTenant(db: DbExecutor, tenantIds: readonly string[], days = 7, now = new Date()): Promise<Map<string, number>> {
  if (!tenantIds.length) return new Map();
  const rows = await db.select({ tenantId: schema.jobRuns.tenantId, n: sql<number>`count(*)::int` }).from(schema.jobRuns).where(and(inArray(schema.jobRuns.tenantId, [...tenantIds]), eq(schema.jobRuns.status, "failed"), gte(schema.jobRuns.startedAt, new Date(now.getTime() - days * 864e5)))).groupBy(schema.jobRuns.tenantId);
  return new Map(rows.map((r) => [r.tenantId!, r.n]));
}

/** Job history older than the platform retention window goes (runs left "running" by a crash too). */
export async function purgeJobRuns(db: DbExecutor, opts: { days: number; now?: Date }): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.days * 864e5);
  const r = await db.delete(schema.jobRuns).where(lt(schema.jobRuns.startedAt, cutoff));
  return r.rowCount ?? 0;
}
