import { getTableColumns, getTableName, gt, is, type Column } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, lt, recordAudit, schema, sql, type Database, type DbExecutor } from "@hullwise/db";
import { TENANT_EXPORT_TTL_DAYS } from "@hullwise/config";
import { csvLine } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";
import { runCustomerExport } from "../crm/data-request";
import { zipFiles } from "./zip";

/**
 * Tenant data export (#32): every tenant table, one CSV each, read inside the tenant's RLS
 * transaction (`ServiceContext.tx`), so the database itself guarantees that no other tenant's row
 * can end up in the archive; the explicit `tenant_id` filter is a second fence. Secrets never leave
 * (encrypted credentials, token hashes, signing secrets), nor binary blobs (logos, photos,
 * attachments) or earlier export files. The zip is kept until it expires, then deleted.
 */
export class TenantExportError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "expired" | "in_progress") {
    super(code);
    this.name = "TenantExportError";
  }
}

const EXCLUDED_TABLES = new Set(["tenant_data_exports"]);
const EXCLUDED_COLUMNS = new Set(["list_exports.content"]);
const SECRET_COLUMN = /(_encrypted$|^secret$|_secret$|token_hash$|token_hint$|_token$|password)/;
const CHUNK = 5000;
const BOM = String.fromCharCode(0xfeff);

export interface ExportableTable {
  name: string;
  table: PgTable;
  columns: { key: string; name: string; column: Column }[];
}

/** Whether a column may leave Hullwise in an export: no binary blob, no secret, no earlier export file. */
export function isExportableColumn(table: string, c: Column): boolean {
  return c.getSQLType() !== "bytea" && !SECRET_COLUMN.test(c.name) && !EXCLUDED_COLUMNS.has(`${table}.${c.name}`);
}

/** Tenant tables and the columns that go into the archive (derived from the schema: a new table is exported without code changes). */
export function exportableTables(): ExportableTable[] {
  const out: ExportableTable[] = [];
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const table = v as PgTable;
    const name = getTableName(table);
    const cols = getTableColumns(table);
    if (!("tenantId" in cols) || !("id" in cols) || EXCLUDED_TABLES.has(name)) continue;
    const columns = Object.entries(cols)
      .filter(([, c]) => isExportableColumn(name, c))
      .map(([key, column]) => ({ key, name: column.name, column }));
    out.push({ name, table, columns });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function cell(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  return JSON.stringify(v);
}

/** One table as CSV (header = database column names), keyset-paginated on `id`. */
async function tableCsv(ctx: ServiceContext, t: ExportableTable): Promise<{ csv: string; rows: number }> {
  const cols = getTableColumns(t.table);
  const idCol = cols.id!;
  const tenantCol = cols.tenantId!;
  const select = Object.fromEntries(t.columns.map((c) => [c.key, c.column]));
  const lines = [csvLine(t.columns.map((c) => c.name))];
  let last: string | null = null;
  let rows = 0;
  for (;;) {
    const page: Record<string, unknown>[] = await ctx.tx
      .select({ ...select, __id: idCol })
      .from(t.table)
      .where(last ? and(eq(tenantCol, ctx.tenantId), gt(idCol, last)) : eq(tenantCol, ctx.tenantId))
      .orderBy(asc(idCol))
      .limit(CHUNK);
    for (const r of page) lines.push(csvLine(t.columns.map((c) => cell(r[c.key]))));
    rows += page.length;
    if (page.length < CHUNK) break;
    last = String(page[page.length - 1]!.__id);
  }
  return { csv: `${BOM}${lines.join("\n")}\n`, rows };
}

/** Queues an export asked by an owner (tenant transaction, audited); the caller enqueues `tenant.export` or runs it inline. */
export async function requestTenantExport(ctx: ServiceContext, input: { userId: string; audit?: { actorType: "user" | "impersonation"; impersonatedBy: string | null } }): Promise<string> {
  const now = ctx.now ?? new Date();
  const [running] = await ctx.tx.select({ id: schema.tenantDataExports.id }).from(schema.tenantDataExports).where(and(eq(schema.tenantDataExports.tenantId, ctx.tenantId), eq(schema.tenantDataExports.scope, "tenant"), sql`${schema.tenantDataExports.status} in ('pending', 'running')`)).limit(1);
  if (running) throw new TenantExportError("in_progress");
  const [row] = await ctx.tx.insert(schema.tenantDataExports).values({ tenantId: ctx.tenantId, requestedBy: input.userId, requestedByType: "owner", status: "pending", createdAt: now, updatedAt: now }).returning({ id: schema.tenantDataExports.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.userId, actorType: input.audit?.actorType ?? "user", impersonatedBy: input.audit?.impersonatedBy ?? null, action: "tenant.data_export_requested", entityType: "tenant_data_export", entityId: row!.id });
  return row!.id;
}

/** The super-admin asks for a tenant's export from the console (admin connection, audited on the tenant). */
export async function requestTenantExportAsAdmin(db: Database, tenantId: string, actorUserId: string, now = new Date()): Promise<string> {
  const [running] = await db.select({ id: schema.tenantDataExports.id }).from(schema.tenantDataExports).where(and(eq(schema.tenantDataExports.tenantId, tenantId), eq(schema.tenantDataExports.scope, "tenant"), sql`${schema.tenantDataExports.status} in ('pending', 'running')`)).limit(1);
  if (running) throw new TenantExportError("in_progress");
  const [row] = await db.insert(schema.tenantDataExports).values({ tenantId, requestedBy: actorUserId, requestedByType: "super_admin", status: "pending", createdAt: now, updatedAt: now }).returning({ id: schema.tenantDataExports.id });
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: "tenant.data_export_requested", entityType: "tenant_data_export", entityId: row!.id });
  return row!.id;
}

/**
 * Builds the archive inside the tenant transaction: one CSV per table plus `manifest.json` (tenant,
 * tables, row counts, excluded columns). Idempotent: a finished export is left alone.
 */
export async function runTenantExport(ctx: ServiceContext, exportId: string): Promise<{ status: "done" | "failed" | "skipped"; rows: number; tables: number }> {
  const e = schema.tenantDataExports;
  const [job] = await ctx.tx.select({ id: e.id, status: e.status, requestedBy: e.requestedBy, requestedByType: e.requestedByType, scope: e.scope, subjectCustomerId: e.subjectCustomerId, subject: e.subject }).from(e).where(and(eq(e.tenantId, ctx.tenantId), eq(e.id, exportId))).limit(1);
  if (!job || job.status === "done" || job.status === "expired") return { status: "skipped", rows: 0, tables: 0 };
  const startedAt = ctx.now ?? new Date();
  await ctx.tx.update(e).set({ status: "running", updatedAt: startedAt }).where(eq(e.id, exportId));
  // one customer's data (GDPR access request): same row, download and expiry, its own content
  if (job.scope === "customer") return runCustomerExport(ctx, job);
  try {
    const [tenant] = await ctx.tx.select({ slug: schema.tenants.slug, name: schema.tenants.name, country: schema.tenants.country, currency: schema.tenants.currency, timezone: schema.tenants.timezone, defaultLocale: schema.tenants.defaultLocale, planKey: schema.tenants.planKey, createdAt: schema.tenants.createdAt }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
    const files: { name: string; data: Buffer }[] = [];
    const tables: Record<string, number> = {};
    const excluded: string[] = [];
    let total = 0;
    for (const t of exportableTables()) {
      const { csv, rows } = await tableCsv(ctx, t);
      files.push({ name: `${t.name}.csv`, data: Buffer.from(csv, "utf8") });
      tables[t.name] = rows;
      total += rows;
      for (const c of Object.values(getTableColumns(t.table))) if (!t.columns.some((x) => x.name === c.name)) excluded.push(`${t.name}.${c.name}`);
    }
    const now = ctx.now ?? new Date();
    const manifest = { tenant: { id: ctx.tenantId, ...tenant }, generatedAt: now.toISOString(), format: "CSV, UTF-8 with BOM, comma separated, header = database column names; JSON columns as JSON text", tables, excludedColumns: excluded.sort() };
    files.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
    const zip = zipFiles(files, now);
    const fileName = `${tenant?.slug ?? "tenant"}-data-${now.toISOString().slice(0, 10)}.zip`;
    const expiresAt = new Date(now.getTime() + TENANT_EXPORT_TTL_DAYS * 864e5);
    await ctx.tx.update(e).set({ status: "done", file: zip, fileName, sizeBytes: zip.length, tables, rowCount: total, error: null, completedAt: now, expiresAt, updatedAt: now }).where(eq(e.id, exportId));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "tenant.data_export_completed", entityType: "tenant_data_export", entityId: exportId, metadata: { tables: Object.keys(tables).length, rows: total, sizeBytes: zip.length, expiresAt: expiresAt.toISOString() } });
    if (job.requestedBy && job.requestedByType === "owner") await notifyUsers(ctx, { userIds: [job.requestedBy], type: "export_ready", title: String(total), body: "tenant_data", link: "/settings/data-export", severity: "success", metadata: { exportId } });
    return { status: "done", rows: total, tables: Object.keys(tables).length };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const now = ctx.now ?? new Date();
    await ctx.tx.update(e).set({ status: "failed", error, completedAt: now, updatedAt: now }).where(eq(e.id, exportId));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "tenant.data_export_failed", entityType: "tenant_data_export", entityId: exportId, metadata: { error } });
    if (job.requestedBy && job.requestedByType === "owner") await notifyUsers(ctx, { userIds: [job.requestedBy], type: "export_ready", title: "failed", body: "tenant_data", link: "/settings/data-export", severity: "warning", metadata: { exportId } });
    return { status: "failed", rows: 0, tables: 0 };
  }
}

const listColumns = { id: schema.tenantDataExports.id, status: schema.tenantDataExports.status, requestedByType: schema.tenantDataExports.requestedByType, requestedByEmail: schema.users.email, rowCount: schema.tenantDataExports.rowCount, tables: schema.tenantDataExports.tables, sizeBytes: schema.tenantDataExports.sizeBytes, fileName: schema.tenantDataExports.fileName, error: schema.tenantDataExports.error, createdAt: schema.tenantDataExports.createdAt, completedAt: schema.tenantDataExports.completedAt, expiresAt: schema.tenantDataExports.expiresAt, downloadedAt: schema.tenantDataExports.downloadedAt, downloadCount: schema.tenantDataExports.downloadCount };

/** Full exports of the tenant (newest first), without the files; customer exports are listed on the customer. Works on the tenant transaction or the admin connection. */
export async function listTenantExports(db: DbExecutor, tenantId: string, limit = 20) {
  return db.select(listColumns).from(schema.tenantDataExports).leftJoin(schema.users, eq(schema.users.id, schema.tenantDataExports.requestedBy)).where(and(eq(schema.tenantDataExports.tenantId, tenantId), eq(schema.tenantDataExports.scope, "tenant"))).orderBy(desc(schema.tenantDataExports.createdAt)).limit(limit);
}

/**
 * The archive of a finished, unexpired export; counts the download and audits it. `db` is the
 * tenant transaction (owner) or the admin connection (super-admin, audited as such).
 */
export async function takeTenantExportFile(db: DbExecutor, tenantId: string, exportId: string, actor: { userId: string; actorType: "user" | "impersonation" | "super_admin"; impersonatedBy?: string | null }, now = new Date()): Promise<{ fileName: string; file: Buffer }> {
  const e = schema.tenantDataExports;
  const [row] = await db.select({ status: e.status, file: e.file, fileName: e.fileName, expiresAt: e.expiresAt, scope: e.scope, subjectCustomerId: e.subjectCustomerId }).from(e).where(and(eq(e.tenantId, tenantId), eq(e.id, exportId))).limit(1);
  if (!row) throw new TenantExportError("not_found");
  if (row.status === "expired" || (row.expiresAt && row.expiresAt <= now)) throw new TenantExportError("expired");
  if (row.status !== "done" || !row.file) throw new TenantExportError("not_ready");
  await db.update(e).set({ downloadedAt: now, downloadCount: sql`${e.downloadCount} + 1`, updatedAt: now }).where(eq(e.id, exportId));
  await recordAudit(db, { tenantId, actorUserId: actor.userId, actorType: actor.actorType, impersonatedBy: actor.impersonatedBy ?? null, action: "tenant.data_export_downloaded", entityType: "tenant_data_export", entityId: exportId, metadata: { scope: row.scope, ...(row.subjectCustomerId ? { customerId: row.subjectCustomerId } : {}) } });
  return { fileName: row.fileName ?? `export-${exportId}.zip`, file: row.file };
}

/** Expired archives are deleted (the row stays, status `expired`): part of the nightly retention tick. */
export async function purgeExpiredTenantExports(db: DbExecutor, now = new Date()): Promise<number> {
  const r = await db.update(schema.tenantDataExports).set({ status: "expired", file: null, updatedAt: now }).where(and(eq(schema.tenantDataExports.status, "done"), lt(schema.tenantDataExports.expiresAt, now)));
  return r.rowCount ?? 0;
}
