import { getTableColumns, getTableName, is, type Column, type SQL } from "drizzle-orm";
import { PgTable, getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, or, recordAudit, schema, sql, type Database, type DbExecutor } from "@hullwise/db";
import { TENANT_EXPORT_TTL_DAYS } from "@hullwise/config";
import { csvLine } from "@hullwise/core";
import { emailAddressHashes } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";
import { isExportableColumn } from "../reliability/data-export";
import { zipFiles } from "../reliability/zip";

/**
 * Everything Hullwise holds about one customer (GDPR art. 15; Shopify `customers/data_request`), read inside
 * the tenant's RLS transaction. Derived from the schema, like the tenant export: the customer row and its
 * orders (also guest orders the platform lists by id), then every tenant table that points at them by
 * `customer_id` / `order_id` or by a foreign key, and the tables that point at those (order lines → return
 * lines, shipments → shipment events, …), up to three levels. A table added later is covered without code
 * changes. Plus the rows keyed on the person's address or phone: email opt-outs, the emails Hullwise sent
 * them (masked recipient), COD risk profiles. Staff notes and timeline entries about their orders are in:
 * the merchant reviews the package before sending it. Secrets and encrypted blobs never leave.
 *
 * The package is a zip (`customer-data.json` with every record, `orders.csv`, `order_lines.csv`) stored as a
 * `customer` row of `tenant_data_exports`, so download, access control (owner, super-admin), audit and expiry
 * are the tenant export's.
 */
export interface CustomerDataSubject {
  customerId?: string | null;
  customerExternalId?: string | null;
  orderExternalIds?: readonly (string | number)[];
  /** Where the request came from (`shopify:customers/data_request:<id>`, or null for a manual one). */
  requestRef?: string | null;
}

type Row = Record<string, unknown>;

export interface CustomerDataPackage {
  format: string;
  generatedAt: string;
  controller: { name: string; slug: string } | null;
  subject: { customerId: string | null; customerExternalId: string | null; orderExternalIds: string[]; requestRef: string | null };
  customer: Row | null;
  orders: Row[];
  /** Every other record, by table (database column names). */
  records: Record<string, Row[]>;
  counts: Record<string, number>;
  /** Tables cut at the row cap (never expected for one person). */
  truncated: string[];
  notIncluded: string[];
}

/** Tables never read for a person: operational copies, platform logs, other exports. */
const SKIP_TABLES = new Set(["customers", "orders", "tenant_data_exports", "list_exports", "webhook_events", "audit_logs", "job_runs", "platform_alerts", "email_messages", "mcp_request_log", "api_request_log", "api_idempotency_keys"]);
/** Encrypted blobs (`bank_details_enc`): useless outside Hullwise and never handed out. */
const ENC_COLUMN = /_enc$/;
const ROW_CAP = 10_000;
const DEPTH = 3;
const BOM = String.fromCharCode(0xfeff);
const NOT_INCLUDED = [
  "raw platform webhook payloads (operational copies of the store platform's own records, deleted after processing)",
  "audit log entries (staff activity records)",
  "the platform-wide bounce and complaint list of the email provider (hashed addresses)",
  "backups, until their retention expires",
];

function tenantTables(): PgTable[] {
  return (Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[]).filter((t) => {
    const cols = getTableColumns(t);
    return "tenantId" in cols && "id" in cols;
  });
}

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return undefined;
  return v;
}

function columnsOf(table: PgTable): { key: string; name: string; column: Column }[] {
  const name = getTableName(table);
  return Object.entries(getTableColumns(table))
    .filter(([, c]) => isExportableColumn(name, c) && !ENC_COLUMN.test(c.name))
    .map(([key, column]) => ({ key, name: column.name, column }));
}

async function rowsWhere(ctx: ServiceContext, table: PgTable, cond: SQL): Promise<Row[]> {
  const cols = columnsOf(table);
  const tenantCol = getTableColumns(table).tenantId!;
  const rows: Row[] = await ctx.tx.select(Object.fromEntries(cols.map((c) => [c.key, c.column])) as Record<string, PgColumn>).from(table).where(and(eq(tenantCol, ctx.tenantId), cond)).limit(ROW_CAP);
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, plain(r[c.key])])));
}

/** Assembles the package (no write). An unknown customer with no matching order gives an empty package. */
export async function buildCustomerDataPackage(ctx: ServiceContext, subject: CustomerDataSubject): Promise<CustomerDataPackage> {
  const t = ctx.tenantId;
  const now = ctx.now ?? new Date();
  const c = schema.customers;
  const o = schema.orders;
  const customerCond = subject.customerId ? eq(c.id, subject.customerId) : subject.customerExternalId ? eq(c.externalId, String(subject.customerExternalId)) : null;
  const [customer] = customerCond ? await rowsWhere(ctx, c, customerCond) : [];
  const orderExternalIds = [...new Set((subject.orderExternalIds ?? []).map(String).filter(Boolean))];
  const orderConds = [...(customer ? [eq(o.customerId, String(customer.id))] : []), ...(orderExternalIds.length ? [inArray(o.externalId, orderExternalIds)] : [])];
  const orders = orderConds.length ? await rowsWhere(ctx, o, or(...orderConds)!) : [];
  const [tenant] = await ctx.tx.select({ name: schema.tenants.name, slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, t)).limit(1);

  const collected = new Map<string, Row[]>([["customers", customer ? [customer] : []], ["orders", orders]]);
  const truncated: string[] = [];
  const customerIds = customer ? [String(customer.id)] : [];
  const orderIds = orders.map((r) => String(r.id));
  const tables = tenantTables();
  for (let depth = 0; depth < DEPTH; depth++) {
    const found: [string, Row[]][] = [];
    for (const table of tables) {
      const name = getTableName(table);
      if (collected.has(name) || SKIP_TABLES.has(name)) continue;
      const cols = getTableColumns(table);
      const conds: SQL[] = [];
      // by name first: `customer_id` / `order_id` columns are not always foreign keys
      if (depth === 0 && cols.customerId && customerIds.length) conds.push(inArray(cols.customerId, customerIds));
      if (depth === 0 && cols.orderId && orderIds.length) conds.push(inArray(cols.orderId, orderIds));
      for (const fk of getTableConfig(table).foreignKeys) {
        const ref = fk.reference();
        if (ref.columns.length !== 1 || ref.foreignColumns[0]?.name !== "id") continue;
        const ids = (collected.get(getTableName(ref.foreignTable)) ?? []).map((r) => String(r.id));
        if (ids.length) conds.push(inArray(ref.columns[0]!, ids));
      }
      if (!conds.length) continue;
      const rows = await rowsWhere(ctx, table, or(...conds)!);
      if (rows.length >= ROW_CAP) truncated.push(name);
      if (rows.length) found.push([name, rows]);
    }
    if (!found.length) break;
    for (const [name, rows] of found) collected.set(name, rows);
  }

  // staff notes attached to any of these records (polymorphic: entity type + id, no foreign key)
  const recordIds = [...new Set([...collected.values()].flat().map((r) => String(r.id)))].slice(0, ROW_CAP);
  if (recordIds.length && !collected.has("record_notes")) {
    const rn = schema.recordNotes;
    const notes = await rowsWhere(ctx, rn, inArray(rn.entityId, recordIds));
    if (notes.length) collected.set("record_notes", notes);
  }

  // rows keyed on the person's address or phone rather than on an id
  const emails = [...new Set([customer?.email_normalized, ...orders.map((r) => r.email_normalized)].filter((v): v is string => typeof v === "string" && !!v))];
  const phones = [...new Set([customer?.phone_e164, ...orders.map((r) => r.phone_e164)].filter((v): v is string => typeof v === "string" && !!v))];
  if (emails.length || phones.length) {
    const es = schema.emailSuppressions;
    const suppressions = await rowsWhere(ctx, es, inArray(es.email, [...emails, ...phones]));
    if (suppressions.length) collected.set("email_suppressions", suppressions);
  }
  if (emails.length) {
    const em = schema.emailMessages;
    const sent = await ctx.tx.select({ id: em.id, template: em.template, category: em.category, kind: em.kind, recipient: em.recipientMasked, locale: em.locale, status: em.status, createdAt: em.createdAt, sentAt: em.sentAt, deliveredAt: em.deliveredAt }).from(em).where(and(eq(em.tenantId, t), inArray(em.recipientHash, emails.flatMap(emailAddressHashes)))).orderBy(desc(em.createdAt)).limit(ROW_CAP);
    if (sent.length) collected.set("email_messages", sent.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]))));
  }
  const keys = [...phones, ...emails.map((e) => `email:${e}`)];
  if (keys.length && !collected.has("cod_recipient_profiles")) {
    const rp = schema.codRecipientProfiles;
    const profiles = await rowsWhere(ctx, rp, inArray(rp.recipientKey, keys));
    if (profiles.length) collected.set("cod_recipient_profiles", profiles);
  }

  const records: Record<string, Row[]> = {};
  const counts: Record<string, number> = { customers: customer ? 1 : 0, orders: orders.length };
  for (const name of [...collected.keys()].sort()) {
    if (name === "customers" || name === "orders") continue;
    records[name] = collected.get(name)!;
    counts[name] = records[name]!.length;
  }
  return {
    format: "JSON, one object; records by table with the database column names; amounts in minor units (cents) of the order's currency",
    generatedAt: now.toISOString(),
    controller: tenant ?? null,
    subject: { customerId: customer ? String(customer.id) : (subject.customerId ?? null), customerExternalId: customer?.external_id ? String(customer.external_id) : (subject.customerExternalId ? String(subject.customerExternalId) : null), orderExternalIds, requestRef: subject.requestRef ?? null },
    customer: customer ?? null,
    orders,
    records,
    counts,
    truncated,
    notIncluded: NOT_INCLUDED,
  };
}

function rowsCsv(rows: Row[]): string {
  const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean));
  return `${BOM}${[csvLine(header), ...rows.map((r) => csvLine(header.map((h) => cell(r[h]))))].join("\n")}\n`;
}

/** The zip of a package: the JSON with everything, and the orders and their lines as CSV for a spreadsheet. */
export function customerDataZip(pkg: CustomerDataPackage, now: Date): Buffer {
  return zipFiles(
    [
      { name: "customer-data.json", data: Buffer.from(JSON.stringify(pkg, null, 2), "utf8") },
      { name: "orders.csv", data: Buffer.from(rowsCsv(pkg.orders), "utf8") },
      { name: "order_lines.csv", data: Buffer.from(rowsCsv(pkg.records.order_lines ?? []), "utf8") },
    ],
    now,
  );
}

function subjectOf(s: CustomerDataSubject) {
  return { customerExternalId: s.customerExternalId ? String(s.customerExternalId) : null, orderExternalIds: [...new Set((s.orderExternalIds ?? []).map(String))], requestRef: s.requestRef ?? null };
}

/**
 * Queues the export of one customer's data (tenant transaction): an owner from the customer page, or the
 * platform's privacy webhook (`requestedBy` null, type `system`). The caller enqueues `tenant.export`.
 * A pending one for the same customer is reused.
 */
export async function requestCustomerExport(ctx: ServiceContext, input: CustomerDataSubject & { userId: string | null; audit?: { actorType: "user" | "impersonation" | "system"; impersonatedBy: string | null } }): Promise<string> {
  const now = ctx.now ?? new Date();
  const e = schema.tenantDataExports;
  if (input.customerId) {
    const [pending] = await ctx.tx.select({ id: e.id }).from(e).where(and(eq(e.tenantId, ctx.tenantId), eq(e.scope, "customer"), eq(e.subjectCustomerId, input.customerId), sql`${e.status} in ('pending', 'running')`)).limit(1);
    if (pending) return pending.id;
  }
  const [row] = await ctx.tx.insert(e).values({ tenantId: ctx.tenantId, requestedBy: input.userId, requestedByType: input.userId ? "owner" : "system", scope: "customer", subjectCustomerId: input.customerId ?? null, subject: subjectOf(input), status: "pending", createdAt: now, updatedAt: now }).returning({ id: e.id });
  const actorType = input.audit?.actorType ?? (input.userId ? "user" : "system");
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.userId, actorType, impersonatedBy: input.audit?.impersonatedBy ?? null, action: "customer.data_export_requested", entityType: "customer", entityId: input.customerId ?? "guest", metadata: { exportId: row!.id, ...subjectOf(input) } });
  return row!.id;
}

/** The super-admin asks for (or rebuilds) a customer's export from the console: admin connection, audited on the tenant. */
export async function requestCustomerExportAsAdmin(db: Database, tenantId: string, input: CustomerDataSubject, actorUserId: string, now = new Date()): Promise<string> {
  const e = schema.tenantDataExports;
  const [row] = await db.insert(e).values({ tenantId, requestedBy: actorUserId, requestedByType: "super_admin", scope: "customer", subjectCustomerId: input.customerId ?? null, subject: subjectOf(input), status: "pending", createdAt: now, updatedAt: now }).returning({ id: e.id });
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: "customer.data_export_requested", entityType: "customer", entityId: input.customerId ?? "guest", metadata: { exportId: row!.id, ...subjectOf(input) } });
  return row!.id;
}

/** Builds and stores the zip of a `customer` export (called by `runTenantExport` for that scope). */
export async function runCustomerExport(ctx: ServiceContext, job: { id: string; requestedBy: string | null; requestedByType: string; subjectCustomerId: string | null; subject: { customerExternalId?: string | null; orderExternalIds?: string[]; requestRef?: string | null } | null }): Promise<{ status: "done" | "failed"; rows: number; tables: number }> {
  const e = schema.tenantDataExports;
  const now = ctx.now ?? new Date();
  const link = job.subjectCustomerId ? `/customers/${job.subjectCustomerId}` : "/customers";
  try {
    const pkg = await buildCustomerDataPackage(ctx, { customerId: job.subjectCustomerId, customerExternalId: job.subject?.customerExternalId ?? null, orderExternalIds: job.subject?.orderExternalIds ?? [], requestRef: job.subject?.requestRef ?? null });
    const zip = customerDataZip(pkg, now);
    const rows = Object.values(pkg.counts).reduce((a, b) => a + b, 0);
    const tables = Object.values(pkg.counts).filter((n) => n > 0).length;
    const fileName = `customer-${(pkg.subject.customerId ?? pkg.subject.customerExternalId ?? "guest").slice(0, 8)}-data-${now.toISOString().slice(0, 10)}.zip`;
    const expiresAt = new Date(now.getTime() + TENANT_EXPORT_TTL_DAYS * 864e5);
    await ctx.tx.update(e).set({ status: "done", file: zip, fileName, sizeBytes: zip.length, tables: pkg.counts, rowCount: rows, error: null, completedAt: now, expiresAt, updatedAt: now }).where(eq(e.id, job.id));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "customer.data_export_completed", entityType: "customer", entityId: pkg.subject.customerId ?? "guest", metadata: { exportId: job.id, tables, rows, sizeBytes: zip.length, expiresAt: expiresAt.toISOString(), requestRef: pkg.subject.requestRef } });
    if (job.requestedBy && job.requestedByType === "owner") await notifyUsers(ctx, { userIds: [job.requestedBy], type: "export_ready", title: String(rows), body: "customer_data", link, severity: "success", metadata: { exportId: job.id } });
    return { status: "done", rows, tables };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await ctx.tx.update(e).set({ status: "failed", error, completedAt: now, updatedAt: now }).where(eq(e.id, job.id));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "customer.data_export_failed", entityType: "customer", entityId: job.subjectCustomerId ?? "guest", metadata: { exportId: job.id, error } });
    if (job.requestedBy && job.requestedByType === "owner") await notifyUsers(ctx, { userIds: [job.requestedBy], type: "export_ready", title: "failed", body: "customer_data", link, severity: "warning", metadata: { exportId: job.id } });
    return { status: "failed", rows: 0, tables: 0 };
  }
}

/** A customer's data exports (newest first, no files), for the customer page. */
export async function listCustomerExports(db: DbExecutor, tenantId: string, customerId: string, limit = 5) {
  const e = schema.tenantDataExports;
  return db.select({ id: e.id, status: e.status, requestedByType: e.requestedByType, rowCount: e.rowCount, sizeBytes: e.sizeBytes, fileName: e.fileName, error: e.error, createdAt: e.createdAt, completedAt: e.completedAt, expiresAt: e.expiresAt, downloadCount: e.downloadCount }).from(e).where(and(eq(e.tenantId, tenantId), eq(e.scope, "customer"), eq(e.subjectCustomerId, customerId))).orderBy(desc(e.createdAt)).limit(limit);
}

/** State of the exports the console tasks point at (admin connection): status and expiry by export id. */
export async function exportStates(db: DbExecutor, exportIds: readonly string[]) {
  if (!exportIds.length) return new Map<string, { status: string; expiresAt: Date | null; tenantId: string }>();
  const e = schema.tenantDataExports;
  const rows = await db.select({ id: e.id, status: e.status, expiresAt: e.expiresAt, tenantId: e.tenantId }).from(e).where(inArray(e.id, [...exportIds]));
  return new Map(rows.map((r) => [r.id, { status: r.status, expiresAt: r.expiresAt, tenantId: r.tenantId }]));
}
