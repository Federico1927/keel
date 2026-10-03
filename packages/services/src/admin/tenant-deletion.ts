import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { and, desc, eq, recordAudit, schema, sql, withTenant, type Database } from "@hullwise/db";
import { DEMO_TENANT_SLUGS } from "@hullwise/config";
import type { BillingProvider } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { getBillingProvider } from "../billing/provider";
import { transitionTenant } from "../billing/lifecycle";
import { getCommercePlatformFor } from "../integrations/factory";

/**
 * Deleting a whole tenant from the console (the store leaves: Shopify `shop/redact`, or the merchant asks).
 * `requestTenantDeletion` checks the typed slug (plus an extra confirmation for the demo tenants and when no
 * final export was downloaded), locks the tenant out (churned), and records a `tenant_deletions` row, a
 * platform row with no foreign key to the tenant. The `tenant.delete` job (`runTenantDeletion`) then:
 * unregisters the store's webhooks through the adapter and drops every credential, cancels the subscription
 * through the BillingProvider, deletes the rows table by table inside the tenant's RLS transaction
 * (children first; progress in `steps`), deletes the tenant row (cascading what the application role
 * cannot delete: audit entries, job history, alerts) and writes a platform audit entry (`tenant_id` null)
 * that survives, with the counts and the tenant's invoice list for the platform's own accounts.
 */
export class TenantDeletionError extends Error {
  constructor(readonly code: "not_found" | "confirmation_mismatch" | "demo_confirmation_required" | "export_required" | "in_progress") {
    super(code);
    this.name = "TenantDeletionError";
  }
}

export interface TenantDeletionStep {
  step: string;
  rows?: number;
  note?: string;
  at: string;
}

/** Every table carrying `tenant_id`, ordered so that a table comes before the tables it references (children first). */
export function tenantTablesInDeletionOrder(): PgTable[] {
  const tables = (Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[]).filter((t) => "tenantId" in getTableColumns(t));
  const byName = new Map(tables.map((t) => [getTableName(t), t]));
  // parents[name] = tenant tables `name` references (self references ignored)
  const parents = new Map<string, Set<string>>();
  for (const t of tables) {
    const name = getTableName(t);
    parents.set(name, new Set(getTableConfig(t).foreignKeys.map((fk) => getTableName(fk.reference().foreignTable)).filter((p) => p !== name && byName.has(p))));
  }
  const out: PgTable[] = [];
  const left = new Set(byName.keys());
  while (left.size) {
    // a table nobody left references can go now
    const ready = [...left].filter((n) => ![...left].some((other) => other !== n && parents.get(other)!.has(n))).sort();
    const next = ready.length ? ready : [[...left].sort()[0]!]; // a cycle: cascades and set-null resolve it
    for (const n of next) {
      out.push(byName.get(n)!);
      left.delete(n);
    }
  }
  return out;
}

/** Rows per tenant table (admin connection): what a deletion would remove. */
export async function tenantRowCounts(db: Database, tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of tenantTablesInDeletionOrder()) {
    const name = getTableName(t);
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${tenantId}::uuid`);
    const n = r.rows[0]?.n ?? 0;
    if (n) counts[name] = n;
  }
  return counts;
}

export const isDemoTenantSlug = (slug: string) => (DEMO_TENANT_SLUGS as readonly string[]).includes(slug);

/** What the console's danger zone shows before a deletion: counts, users left without a workspace, the last export. */
export async function tenantDeletionPreview(db: Database, tenantId: string) {
  const [tenant] = await db.select({ id: schema.tenants.id, slug: schema.tenants.slug, name: schema.tenants.name, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  const counts = await tenantRowCounts(db, tenantId);
  const e = schema.tenantDataExports;
  const [lastExport] = await db.select({ id: e.id, status: e.status, completedAt: e.completedAt, expiresAt: e.expiresAt, downloadCount: e.downloadCount }).from(e).where(and(eq(e.tenantId, tenantId), eq(e.scope, "tenant"))).orderBy(desc(e.createdAt)).limit(1);
  const m = schema.tenantMemberships;
  const [only] = await db.select({ n: sql<number>`count(*)::int` }).from(m).where(and(eq(m.tenantId, tenantId), sql`not exists (select 1 from tenant_memberships o where o.user_id = ${m.userId} and o.tenant_id <> ${tenantId}::uuid)`));
  const integrations = await db.select({ provider: schema.integrations.provider, mode: schema.integrations.mode, status: schema.integrations.status }).from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId));
  const [subscription] = await db.select({ provider: schema.subscriptions.provider, status: schema.subscriptions.status, externalSubscriptionId: schema.subscriptions.externalSubscriptionId }).from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  return {
    tenant,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    isDemo: isDemoTenantSlug(tenant.slug),
    lastExport: lastExport ?? null,
    exportDownloaded: !!lastExport && lastExport.status === "done" && lastExport.downloadCount > 0,
    usersOnlyHere: only?.n ?? 0,
    integrations: integrations.filter((i) => i.status !== "not_connected"),
    subscription: subscription ?? null,
  };
}

/** The latest deletion recorded for a tenant id (it outlives the tenant). */
export async function latestTenantDeletion(db: Database, tenantRef: string) {
  const [row] = await db.select().from(schema.tenantDeletions).where(eq(schema.tenantDeletions.tenantRef, tenantRef)).orderBy(desc(schema.tenantDeletions.createdAt)).limit(1);
  return row ?? null;
}

export interface TenantDeletionRequest {
  confirmSlug: string;
  /** Required for the demo tenants: the next reseed recreates them, and the public demo breaks until then. */
  confirmDemo?: boolean;
  /** Required when no final data export was downloaded: the merchant does not want one. */
  withoutExport?: boolean;
  reason?: string | null;
}

/** Validates and records the deletion (admin connection, audited on the tenant); the caller enqueues `tenant.delete`. */
export async function requestTenantDeletion(db: Database, tenantId: string, input: TenantDeletionRequest, actorUserId: string, now = new Date()): Promise<string> {
  const preview = await tenantDeletionPreview(db, tenantId);
  if (!preview) throw new TenantDeletionError("not_found");
  if (input.confirmSlug.trim() !== preview.tenant.slug) throw new TenantDeletionError("confirmation_mismatch");
  if (preview.isDemo && !input.confirmDemo) throw new TenantDeletionError("demo_confirmation_required");
  if (!preview.exportDownloaded && !input.withoutExport) throw new TenantDeletionError("export_required");
  const running = await latestTenantDeletion(db, tenantId);
  if (running && (running.status === "pending" || running.status === "running")) throw new TenantDeletionError("in_progress");
  const reason = input.reason?.trim().slice(0, 500) || null;
  // users are locked out at once: a churned tenant opens for nobody
  try {
    await transitionTenant(db, tenantId, { to: "churned", reason: "customer_request", note: "tenant deletion", actorUserId, now });
  } catch {
    await db.update(schema.tenants).set({ status: "churned", churnedAt: now, statusChangedAt: now, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
  }
  const totalSteps = 3 + Object.keys(preview.counts).length;
  const [row] = await db.insert(schema.tenantDeletions).values({ tenantRef: tenantId, slug: preview.tenant.slug, name: preview.tenant.name, requestedBy: actorUserId, reason, status: "pending", counts: preview.counts, totalSteps, createdAt: now, updatedAt: now }).returning({ id: schema.tenantDeletions.id });
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: "tenant.deletion_requested", entityType: "tenant", entityId: tenantId, metadata: { deletionId: row!.id, rows: preview.total, withoutExport: !preview.exportDownloaded, demo: preview.isDemo, reason } });
  return row!.id;
}

export interface TenantDeletionOptions {
  provider?: BillingProvider;
  /** Hullwise's Shopify webhook URL (`apiEndpoint("/webhooks/shopify")`): only those subscriptions are removed. */
  webhookCallbackUrl: string;
  /** App connection for the tenant's RLS transactions (default: the app connection; tests pass theirs). */
  tenantDb?: Database;
  now?: () => Date;
}

/**
 * The background part, resumable: a failed run is retried from the steps not yet done (table deletes are
 * idempotent). Returns the final status.
 */
export async function runTenantDeletion(db: Database, deletionId: string, opts: TenantDeletionOptions): Promise<{ status: "done" | "skipped"; rows: number }> {
  const now = opts.now ?? (() => new Date());
  const d = schema.tenantDeletions;
  const [del] = await db.select().from(d).where(eq(d.id, deletionId)).limit(1);
  if (!del || del.status === "done") return { status: "skipped", rows: 0 };
  const tenantId = del.tenantRef;
  const steps: TenantDeletionStep[] = [...del.steps];
  const done = (step: string) => steps.some((s) => s.step === step);
  const mark = async (step: TenantDeletionStep) => {
    steps.push(step);
    await db.update(d).set({ steps, updatedAt: now() }).where(eq(d.id, deletionId));
  };
  await db.update(d).set({ status: "running", startedAt: del.startedAt ?? now(), error: null, updatedAt: now() }).where(eq(d.id, deletionId));
  try {
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    const sys = (tx: ServiceContext["tx"]): ServiceContext => ({ tenantId, tx, actor: { type: "system", userId: null }, now: now() });
    // invoices issued to the tenant, kept in the surviving audit entry (the platform's own accounts)
    const invoices = tenant ? await db.select({ number: schema.invoices.number, kind: schema.invoices.kind, amountMinor: schema.invoices.amountMinor, currency: schema.invoices.currency, status: schema.invoices.status, issuedAt: schema.invoices.issuedAt, provider: schema.invoices.provider, externalId: schema.invoices.externalId }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)) : [];

    if (tenant && !done("disconnect")) {
      const rows = await db.select({ provider: schema.integrations.provider, mode: schema.integrations.mode, status: schema.integrations.status, credentials: schema.integrations.credentialsEncrypted }).from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId));
      const shopify = rows.find((r) => r.provider === "shopify" && r.status !== "not_connected");
      let note = "no store connected";
      if (shopify) {
        try {
          const r = await withTenant(tenantId, async (tx) => (await getCommercePlatformFor(sys(tx), { id: tenantId, currency: tenant.currency, country: tenant.country, orderNumberPrefix: tenant.orderNumberPrefix })).unregisterWebhooks(opts.webhookCallbackUrl), opts.tenantDb);
          note = `${shopify.mode}: ${r.removed} webhook subscriptions removed${r.failed ? `, ${r.failed} failed` : ""}`;
        } catch (e) {
          // a store that already uninstalled the app answers 401: nothing left to remove there
          note = `${shopify.mode}: webhooks not removed (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
        }
      }
      await withTenant(tenantId, (tx) => tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, updatedAt: now() }).where(eq(schema.integrations.tenantId, tenantId)), opts.tenantDb);
      await mark({ step: "disconnect", note: `${note}; credentials of ${rows.length} integrations dropped`, at: now().toISOString() });
    }

    if (tenant && !done("billing")) {
      const provider = opts.provider ?? getBillingProvider();
      const [sub] = await db.select({ provider: schema.subscriptions.provider, status: schema.subscriptions.status, externalSubscriptionId: schema.subscriptions.externalSubscriptionId }).from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
      let note = "no subscription";
      if (sub?.externalSubscriptionId && sub.provider !== provider.provider) note = `${sub.provider} subscription ${sub.externalSubscriptionId}: provider not configured here, cancel it by hand`;
      else if (sub?.externalSubscriptionId) {
        const snap = await provider.cancelSubscription(sub.externalSubscriptionId, `hullwise-tenant-delete-${deletionId}`);
        note = `${sub.provider} subscription ${sub.externalSubscriptionId} ${snap ? `cancelled (${snap.status || "canceled"})` : "already gone"}`;
      } else if (sub) note = `${sub.provider} subscription without provider id: nothing to cancel`;
      await mark({ step: "billing", note, at: now().toISOString() });
    }

    let deleted = 0;
    if (tenant) {
      for (const table of tenantTablesInDeletionOrder()) {
        const name = getTableName(table);
        if (!(name in del.counts) || done(`table:${name}`)) continue;
        const col = getTableColumns(table).tenantId!;
        // inside the tenant's RLS transaction: a bug here can never reach another tenant's rows
        const r = await withTenant(tenantId, (tx) => tx.delete(table).where(eq(col, tenantId)), opts.tenantDb);
        deleted += r.rowCount ?? 0;
        await mark({ step: `table:${name}`, rows: r.rowCount ?? 0, at: now().toISOString() });
      }
      // the tenant row last: cascades what the application role may not delete (audit, job history, alerts, memberships)
      await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
      await mark({ step: "tenant", at: now().toISOString() });
    }
    const counted = Object.values(del.counts).reduce((a, b) => a + b, 0);
    await recordAudit(db, { tenantId: null, actorUserId: del.requestedBy, actorType: del.requestedBy ? "super_admin" : "system", action: "tenant.deleted", entityType: "tenant", entityId: tenantId, metadata: { deletionId, slug: del.slug, name: del.name, reason: del.reason, rowsCounted: counted, tables: Object.keys(del.counts).length, steps: steps.filter((s) => !s.step.startsWith("table:")), invoices } });
    await db.update(d).set({ status: "done", completedAt: now(), updatedAt: now() }).where(eq(d.id, deletionId));
    return { status: "done", rows: deleted };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.update(d).set({ status: "failed", error, updatedAt: now() }).where(eq(d.id, deletionId));
    throw err;
  }
}

/** Puts a failed deletion back in the queue (the caller enqueues `tenant.delete` again). */
export async function retryTenantDeletion(db: Database, deletionId: string, actorUserId: string): Promise<boolean> {
  const r = await db.update(schema.tenantDeletions).set({ status: "pending", error: null, updatedAt: new Date() }).where(and(eq(schema.tenantDeletions.id, deletionId), eq(schema.tenantDeletions.status, "failed"))).returning({ tenantRef: schema.tenantDeletions.tenantRef });
  if (!r.length) return false;
  await recordAudit(db, { tenantId: null, actorUserId, actorType: "super_admin", action: "tenant.deletion_retried", entityType: "tenant", entityId: r[0]!.tenantRef, metadata: { deletionId } });
  return true;
}
