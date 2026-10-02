import { and, asc, desc, eq, ilike, inArray, or, recordAudit, schema, sql, type DbExecutor, type SQL } from "@hullwise/db";
import { ADDON_MODULES, MODULES, PLANS, PLAN_KEYS, SOURCE_ERROR_STATUSES, TENANT_STATUSES, type PlanKey, type TenantStatus } from "@hullwise/config";
import { csvAmount, csvLine, lastMonths, platformSeries, type LifecycleSnapshot, type PlatformMonth, type QueryParams } from "@hullwise/core";
import { tenantsOverview, type AdminDb, type TenantOverviewRow } from "../billing";

/**
 * Console tables (#48): filters, search and sort come from the URL query, so the page, its CSV
 * export and a shared link all read the same list. Every function runs on the admin connection.
 */

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const isUuid = (v: string | undefined): v is string => Boolean(v && /^[0-9a-f-]{36}$/i.test(v));
const BOM = String.fromCharCode(0xfeff);

/* ---------- tenants ---------- */

export const TENANT_SORTS = ["name", "status", "plan", "orders", "mrr", "health", "login", "created", "trial_end"] as const;
export type TenantSort = (typeof TENANT_SORTS)[number];

export interface TenantListFilters {
  q?: string;
  status?: TenantStatus;
  plan?: PlanKey;
  payment?: "ok" | "past_due" | "suspended" | "none";
  addon?: string;
  attention?: boolean;
  sort: TenantSort;
  dir: "asc" | "desc";
}

export function parseTenantListFilters(p: QueryParams): TenantListFilters {
  const status = one(p.status);
  const plan = one(p.plan);
  const payment = one(p.payment);
  const addon = one(p.addon);
  const sort = one(p.sort);
  const dir = one(p.dir);
  return {
    q: one(p.q)?.slice(0, 120),
    status: (TENANT_STATUSES as readonly string[]).includes(status ?? "") ? (status as TenantStatus) : undefined,
    plan: (PLAN_KEYS as readonly string[]).includes(plan ?? "") ? (plan as PlanKey) : undefined,
    payment: ["ok", "past_due", "suspended", "none"].includes(payment ?? "") ? (payment as TenantListFilters["payment"]) : undefined,
    addon: (ADDON_MODULES as readonly string[]).includes(addon ?? "") ? addon : undefined,
    attention: one(p.attention) === "1",
    sort: (TENANT_SORTS as readonly string[]).includes(sort ?? "") ? (sort as TenantSort) : "name",
    dir: dir === "desc" ? "desc" : dir === "asc" ? "asc" : "asc",
  };
}

const STATUS_ORDER: Record<string, number> = { trial: 0, active: 1, past_due: 2, suspended: 3, churned: 4 };

export function filterTenantRows(rows: readonly TenantOverviewRow[], f: TenantListFilters): TenantOverviewRow[] {
  const q = f.q?.toLowerCase();
  const out = rows.filter((r) => (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) && (!f.status || r.status === f.status) && (!f.plan || r.planKey === f.plan) && (!f.payment || r.payment === f.payment) && (!f.addon || r.addons.includes(f.addon)) && (!f.attention || r.health.needsAttention));
  const key = (r: TenantOverviewRow): number | string => {
    switch (f.sort) {
      case "status": return STATUS_ORDER[r.status] ?? 9;
      case "plan": return PLAN_KEYS.indexOf(r.planKey as PlanKey);
      case "orders": return r.ordersLast30;
      case "mrr": return r.mrrMinor;
      case "health": return r.health.score;
      case "login": return r.lastLoginAt?.getTime() ?? 0;
      case "created": return r.createdAt.getTime();
      case "trial_end": return r.trialEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      default: return r.name.toLowerCase();
    }
  };
  const sign = f.dir === "desc" ? -1 : 1;
  return out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return (ka < kb ? -1 : ka > kb ? 1 : 0) * sign || a.name.localeCompare(b.name);
  });
}

export async function adminTenantList(db: AdminDb, params: QueryParams, now = new Date()) {
  const filters = parseTenantListFilters(params);
  const all = await tenantsOverview(db, now);
  return { filters, rows: filterTenantRows(all, filters), total: all.length };
}

export async function tenantsCsv(db: AdminDb, params: QueryParams, actorUserId: string, now = new Date()): Promise<{ csv: string; rows: number }> {
  const { rows } = await adminTenantList(db, params, now);
  const lines = [csvLine(["tenant_id", "name", "slug", "status", "status_reason", "plan", "country", "currency", "addons", "mrr", "orders_30d", "payment", "open_balance", "days_overdue", "health_score", "needs_attention", "integration_errors", "failed_jobs", "trial_ends_at", "churned_at", "last_login_at", "created_at"])];
  for (const r of rows) lines.push(csvLine([r.id, r.name, r.slug, r.status, r.statusReason, r.planKey, r.country, r.currency, r.addons.join("|"), csvAmount(r.mrrMinor), r.ordersLast30, r.payment, csvAmount(r.openMinor), r.daysOverdue, r.health.score, r.health.needsAttention, r.integrationErrors, r.failedJobs, r.trialEndsAt, r.churnedAt, r.lastLoginAt, r.createdAt]));
  await recordAudit(db, { tenantId: null, actorUserId, actorType: "super_admin", action: "admin.export_csv", entityType: "tenants", metadata: { list: "tenants", rows: rows.length, query: params } });
  return { csv: BOM + lines.join("\r\n") + "\r\n", rows: rows.length };
}

/* ---------- invoices ---------- */

export const INVOICE_SORTS = ["issued", "due", "amount", "number", "tenant"] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];

export interface InvoiceListFilters {
  q?: string;
  status?: string;
  kind?: string;
  tenantId?: string;
  overdue?: boolean;
  sort: InvoiceSort;
  dir: "asc" | "desc";
  page: number;
}

export function parseInvoiceListFilters(p: QueryParams): InvoiceListFilters {
  const status = one(p.status);
  const kind = one(p.kind);
  const sort = one(p.sort);
  const tenant = one(p.tenant);
  return {
    q: one(p.q)?.slice(0, 120),
    status: ["open", "paid", "void", "uncollectible"].includes(status ?? "") ? status : undefined,
    kind: ["setup", "subscription", "adjustment"].includes(kind ?? "") ? kind : undefined,
    tenantId: isUuid(tenant) ? tenant : undefined,
    overdue: one(p.overdue) === "1",
    sort: (INVOICE_SORTS as readonly string[]).includes(sort ?? "") ? (sort as InvoiceSort) : "issued",
    dir: one(p.dir) === "asc" ? "asc" : "desc",
    page: Math.max(1, Number(one(p.page)) || 1),
  };
}

function invoiceWhere(f: InvoiceListFilters, now: Date): SQL | undefined {
  const i = schema.invoices;
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(i.status, f.status));
  if (f.kind) conds.push(eq(i.kind, f.kind));
  if (f.tenantId) conds.push(eq(i.tenantId, f.tenantId));
  if (f.overdue) conds.push(and(eq(i.status, "open"), sql`${i.dueAt} < ${now}`)!);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(i.number, like), ilike(schema.tenants.name, like), ilike(schema.tenants.slug, like))!);
  }
  return conds.length ? and(...conds) : undefined;
}

function invoiceOrder(f: InvoiceListFilters) {
  const i = schema.invoices;
  const col = f.sort === "due" ? i.dueAt : f.sort === "amount" ? i.amountMinor : f.sort === "number" ? i.number : f.sort === "tenant" ? schema.tenants.name : i.issuedAt;
  return [f.dir === "asc" ? asc(col) : desc(col), desc(i.id)];
}

export async function adminInvoiceList(db: DbExecutor, params: QueryParams, opts: { now?: Date; pageSize?: number } = {}) {
  const f = parseInvoiceListFilters(params);
  const now = opts.now ?? new Date();
  const pageSize = opts.pageSize ?? 50;
  const where = invoiceWhere(f, now);
  const [rows, [count]] = await Promise.all([
    db.select({ invoice: schema.invoices, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(where).orderBy(...invoiceOrder(f)).limit(pageSize).offset((f.page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${schema.invoices.amountMinor}),0)::bigint` }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(where),
  ]);
  return { filters: f, rows, total: count?.n ?? 0, amountMinor: Number(count?.amount ?? 0), page: f.page, pageSize };
}

export async function invoicesCsv(db: DbExecutor, params: QueryParams, actorUserId: string, now = new Date()): Promise<{ csv: string; rows: number }> {
  const f = { ...parseInvoiceListFilters(params), page: 1 };
  const rows = await db.select({ invoice: schema.invoices, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(invoiceWhere(f, now)).orderBy(...invoiceOrder(f)).limit(50_000);
  const lines = [csvLine(["number", "tenant", "tenant_slug", "kind", "status", "currency", "amount", "issued_at", "due_at", "paid_at", "voided_at", "period_start", "period_end", "provider", "external_id", "invoice_id"])];
  for (const { invoice: i, tenantName, tenantSlug } of rows) lines.push(csvLine([i.number, tenantName, tenantSlug, i.kind, i.status, i.currency, csvAmount(i.amountMinor), i.issuedAt, i.dueAt, i.paidAt, i.voidedAt, i.periodStart, i.periodEnd, i.provider, i.externalId, i.id]));
  await recordAudit(db, { tenantId: null, actorUserId, actorType: "super_admin", action: "admin.export_csv", entityType: "invoices", metadata: { list: "invoices", rows: rows.length, query: params } });
  return { csv: BOM + lines.join("\r\n") + "\r\n", rows: rows.length };
}

/* ---------- metrics over time ---------- */

export const PLATFORM_METRICS = ["mrr", "active", "trial", "new", "churned"] as const;
export type PlatformMetric = (typeof PLATFORM_METRICS)[number];

/** The lifecycle history as snapshots for `platformSeries`. */
export async function lifecycleSnapshots(db: DbExecutor): Promise<LifecycleSnapshot[]> {
  const e = schema.tenantLifecycleEvents;
  const rows = await db.select({ tenantId: e.tenantId, at: e.createdAt, status: e.toStatus, planKey: e.planKey, addons: e.addons }).from(e).orderBy(asc(e.createdAt));
  return rows.filter((r) => (TENANT_STATUSES as readonly string[]).includes(r.status) && r.planKey in PLANS).map((r) => ({ tenantId: r.tenantId, at: r.at, status: r.status as TenantStatus, planKey: r.planKey as PlanKey, addons: Array.isArray(r.addons) ? r.addons : [] }));
}

export async function platformSeriesReport(db: DbExecutor, opts: { months?: number; now?: Date } = {}): Promise<{ months: PlatformMonth[]; tenants: Map<string, { name: string; status: string }> }> {
  const now = opts.now ?? new Date();
  const [snapshots, tenants] = await Promise.all([lifecycleSnapshots(db), db.select({ id: schema.tenants.id, name: schema.tenants.name, status: schema.tenants.status }).from(schema.tenants)]);
  return { months: platformSeries(snapshots, lastMonths(now, opts.months ?? 12)), tenants: new Map(tenants.map((t) => [t.id, { name: t.name, status: t.status }])) };
}

/** The tenant ids behind one number of the series (`metric` is a PlatformMetric or an add-on key). */
export function tenantsBehind(point: PlatformMonth, metric: string): string[] {
  if (metric === "mrr" || metric === "active") return point.active;
  if (metric === "trial") return point.trial;
  if (metric === "new") return point.new;
  if (metric === "churned") return point.churned;
  return point.addons[metric] ?? [];
}

/* ---------- integrations drill-down ---------- */

export interface IntegrationIssueFilters {
  tenantId?: string;
  source?: string;
  status?: "error" | "degraded" | "stale" | "idle" | "all";
}

/** Health rows in error (or degraded) per tenant and source, worst first, with the latest failed runs. */
export async function integrationIssues(db: DbExecutor, f: IntegrationIssueFilters = {}) {
  const h = schema.integrationHealth;
  const conds: SQL[] = [f.status === "all" ? sql`true` : f.status ? eq(h.status, f.status) : inArray(h.status, [...SOURCE_ERROR_STATUSES])];
  if (isUuid(f.tenantId)) conds.push(eq(h.tenantId, f.tenantId));
  if (f.source) conds.push(sql`split_part(${h.source}, ':', 1) = ${f.source}`);
  const rows = await db.select({ health: h, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(h).innerJoin(schema.tenants, eq(schema.tenants.id, h.tenantId)).where(and(...conds)).orderBy(desc(h.consecutiveFailures), desc(h.lastAttemptAt)).limit(200);
  const sources = await db.selectDistinct({ source: sql<string>`split_part(${h.source}, ':', 1)` }).from(h).orderBy(sql`1`);
  // sync runs end in `error` (older rows may say `failed`)
  const runConds: SQL[] = [inArray(schema.syncRuns.status, ["error", "failed"])];
  if (isUuid(f.tenantId)) runConds.push(eq(schema.syncRuns.tenantId, f.tenantId));
  if (f.source) runConds.push(eq(schema.syncRuns.provider, f.source));
  const runs = await db.select({ run: schema.syncRuns, tenantName: schema.tenants.name }).from(schema.syncRuns).innerJoin(schema.tenants, eq(schema.tenants.id, schema.syncRuns.tenantId)).where(and(...runConds)).orderBy(desc(schema.syncRuns.startedAt)).limit(30);
  const [hooks] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.status, "failed"), ...(isUuid(f.tenantId) ? [eq(schema.webhookEvents.tenantId, f.tenantId)] : [])));
  const [writes] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.platformWrites).where(and(eq(schema.platformWrites.status, "failed"), ...(isUuid(f.tenantId) ? [eq(schema.platformWrites.tenantId, f.tenantId)] : [])));
  return { rows, sources: sources.map((s) => s.source), runs, failedWebhooks: hooks?.n ?? 0, failedWrites: writes?.n ?? 0 };
}

/* ---------- plans and add-ons (read-only, from @hullwise/config) ---------- */

export async function planUsage(db: DbExecutor) {
  const [byPlan, byAddon] = await Promise.all([
    db.select({ planKey: schema.tenants.planKey, status: schema.tenants.status, n: sql<number>`count(*)::int` }).from(schema.tenants).groupBy(schema.tenants.planKey, schema.tenants.status),
    db.select({ key: schema.tenantAddons.moduleKey, n: sql<number>`count(*)::int` }).from(schema.tenantAddons).innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantAddons.tenantId)).where(and(eq(schema.tenantAddons.isActive, true), sql`${schema.tenants.status} <> 'churned'`)).groupBy(schema.tenantAddons.moduleKey),
  ]);
  return {
    plans: PLAN_KEYS.map((k) => {
      const rows = byPlan.filter((r) => r.planKey === k);
      return { plan: PLANS[k], tenants: rows.filter((r) => r.status !== "churned").reduce((s, r) => s + r.n, 0), byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number> };
    }),
    addons: ADDON_MODULES.map((k) => ({ module: MODULES[k], tenants: byAddon.find((a) => a.key === k)?.n ?? 0 })),
  };
}
