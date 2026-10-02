/**
 * Mandatory tenant isolation tests (CLAUDE.md §3). For EVERY table in the schema
 * that carries `tenant_id`, this file checks that:
 *  1. RLS is enabled and at least one policy exists;
 *  2. the seed populated rows for both demo tenants (so the checks below are meaningful);
 *  3. tenant B cannot SELECT, UPDATE or DELETE tenant A's rows;
 *  4. tenant B cannot INSERT a row that belongs to tenant A;
 *  5. with no tenant set, the app role sees nothing.
 * Tables without `tenant_id` must be listed in PLATFORM_TABLES explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema";
import { withTenant } from "../src/tenant";
import { testPools } from "../src/test-utils";
import { seedPlatform } from "../src/seed";
import { seedDomainForTests } from "./seed-for-tests";

const PLATFORM_TABLES = new Set(["users", "accounts", "sessions", "verification_tokens", "user_sign_ins", "tenants", "tenant_memberships", "tenant_addons", "email_events", "email_address_suppressions", "password_resets", "oauth_clients", "billing_events", "billing_prices"]);
/** Tenant tables the seed may legitimately leave empty for one tenant. */
const EMPTY_ALLOWED = new Set<string>(["tenant_addons"]);
/** Add-on and plan-gated tables: only tenants with the add-on (or the plan: MCP is Growth and up) carry rows, so the seed populates tenant A alone. */
/** Add-on tables populated for tenant B alone (Harbor Home has `addon.subscriptions`, Northwind does not): the checks run with the roles swapped. */
const ADDON_ONLY_B = new Set<string>(["subscription_contracts", "subscription_contract_lines", "subscription_billing_attempts", "subscription_events", "subscription_cancellation_reasons"]);
const ADDON_ONLY = new Set<string>(["webhook_endpoints", "webhook_deliveries", "api_idempotency_keys", "api_request_log", "mcp_authorization_codes", "mcp_tokens", "mcp_request_log", "mcp_rate_buckets", "mcp_pending_actions", "cod_settings", "cod_queue_items", "cod_attempts", "cod_operator_capacity", "cod_capacity_exceptions", "cod_assignment_log", "cod_recipient_profiles", "cod_messages", "cod_carrier_outcomes", "retention_campaigns", "retention_exposures", "spoki_settings", "spoki_messages", "accounting_settings", "accounting_journals"]);

/** Tables filled only once the tenant connects the integration (#86: GA4 traffic; Harbor Home stays unconnected so its empty state shows): tenant A's rows carry every check. */
const CONNECTED_ONLY = new Set<string>(["analytics_traffic_daily"]);

const pools = testPools();
let tenantA = "";
let tenantB = "";

const allTables: PgTable[] = Object.values(schema).filter((v) => is(v, PgTable)) as unknown as PgTable[];
const tenantTables = allTables.filter((t) => "tenantId" in getTableColumns(t));
const otherTables = allTables.filter((t) => !("tenantId" in getTableColumns(t)));

beforeAll(async () => {
  const ctx = await seedPlatform(pools.admin);
  tenantA = ctx.tenantIds.northwind;
  tenantB = ctx.tenantIds.harbor;
  await seedDomainForTests(pools.admin, ctx);
});
afterAll(() => pools.close());

describe("schema inventory", () => {
  it("every table without tenant_id is a known platform table", () => {
    const unknown = otherTables.map((t) => getTableName(t)).filter((n) => !PLATFORM_TABLES.has(n));
    expect(unknown).toEqual([]);
  });
  it("there is at least one tenant table", () => {
    expect(tenantTables.length).toBeGreaterThan(0);
  });
});

describe.each(tenantTables.map((t) => [getTableName(t), t] as const))("isolation: %s", (name) => {
  // the owner of the rows and the other tenant (swapped for add-on tables only tenant B populates)
  const own = () => (ADDON_ONLY_B.has(name) ? tenantB : tenantA);
  const other = () => (ADDON_ONLY_B.has(name) ? tenantA : tenantB);
  it("has RLS enabled with a policy", async () => {
    const r = await pools.admin.execute<{ relrowsecurity: boolean; policies: number }>(sql`
      select c.relrowsecurity, (select count(*) from pg_policies p where p.tablename = c.relname and p.schemaname = 'public')::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${name}`);
    expect(r.rows[0]?.relrowsecurity).toBe(true);
    expect(r.rows[0]?.policies).toBeGreaterThan(0);
  });

  it("is populated for both tenants by the seed", async () => {
    if (EMPTY_ALLOWED.has(name)) return;
    const r = await pools.admin.execute<{ a: number; b: number }>(sql`
      select count(*) filter (where tenant_id = ${tenantA}::uuid)::int as a,
             count(*) filter (where tenant_id = ${tenantB}::uuid)::int as b
      from ${sql.identifier(name)}`);
    if (!ADDON_ONLY_B.has(name)) expect(r.rows[0]?.a, `${name}: no rows for tenant A`).toBeGreaterThan(0);
    if (!ADDON_ONLY.has(name) && !CONNECTED_ONLY.has(name)) expect(r.rows[0]?.b, `${name}: no rows for tenant B`).toBeGreaterThan(0);
  });

  it("tenant A sees exactly its rows, tenant B none of A's", async () => {
    const adminCount = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${own()}::uuid`);
    const asA = await withTenant(own(), (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)}`), pools.app);
    const asBCross = await withTenant(
      other(),
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${own()}::uuid`),
      pools.app,
    );
    const asBOwn = await withTenant(other(), (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id <> ${other()}::uuid`), pools.app);
    expect(asA.rows[0]?.n).toBe(adminCount.rows[0]?.n);
    expect(asBCross.rows[0]?.n).toBe(0);
    expect(asBOwn.rows[0]?.n).toBe(0);
  });

  it("tenant B cannot update or delete tenant A rows", async () => {
    const upd = await withTenant(other(), (tx) => tx.execute(sql`update ${sql.identifier(name)} set tenant_id = tenant_id where tenant_id = ${own()}::uuid`), pools.app);
    expect(upd.rowCount ?? 0).toBe(0);
    const del = await withTenant(other(), (tx) => tx.execute(sql`delete from ${sql.identifier(name)} where tenant_id = ${own()}::uuid`), pools.app);
    expect(del.rowCount ?? 0).toBe(0);
    // Nothing changed for A.
    const stillThere = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${own()}::uuid`);
    expect(stillThere.rows[0]?.n).toBeGreaterThan(0);
  });

  it("tenant B cannot insert a row for tenant A", async () => {
    const sample = await pools.admin.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(t) as row from ${sql.identifier(name)} t where tenant_id = ${own()}::uuid limit 1`);
    const row = sample.rows[0]?.row;
    if (!row) return;
    const clone = { ...row, id: crypto.randomUUID() };
    // Generated columns cannot be inserted explicitly: list the writable ones.
    const cols = await pools.admin.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${name} and is_generated = 'NEVER' order by ordinal_position`);
    const colList = sql.join(cols.rows.map((c) => sql.identifier(c.column_name)), sql`, `);
    await expect(
      withTenant(
        other(),
        (tx) => tx.execute(sql`insert into ${sql.identifier(name)} (${colList}) select ${colList} from jsonb_populate_record(null::${sql.identifier(name)}, ${JSON.stringify(clone)}::jsonb)`),
        pools.app,
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
  });

  it("app role without tenant context sees nothing", async () => {
    const r = await pools.app.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)}`);
    expect(r.rows[0]?.n).toBe(0);
  });
});

/** TikTok rows (#41) live in the shared ads tables: only Northwind (Growth) has them, and Harbor cannot see or touch them. */
describe("isolation: TikTok rows", () => {
  it.each([["campaigns", "platform"], ["ad_sets", "platform"], ["ad_creatives", "platform"], ["ad_assets", "platform"], ["integrations", "provider"]] as const)("%s: tenant A's TikTok rows are invisible and untouchable for tenant B", async (table, col) => {
    const admin = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${tenantA}::uuid and ${sql.identifier(col)} = 'tiktok'`);
    expect(admin.rows[0]?.n).toBeGreaterThan(0);
    const asA = await withTenant(tenantA, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(col)} = 'tiktok'`), pools.app);
    expect(asA.rows[0]?.n).toBe(admin.rows[0]?.n);
    const asB = await withTenant(tenantB, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(col)} = 'tiktok'`), pools.app);
    expect(asB.rows[0]?.n).toBe(0);
    const upd = await withTenant(tenantB, (tx) => tx.execute(sql`update ${sql.identifier(table)} set tenant_id = tenant_id where ${sql.identifier(col)} = 'tiktok'`), pools.app);
    expect(upd.rowCount ?? 0).toBe(0);
  });

  it("TikTok daily metrics of tenant A are invisible for tenant B", async () => {
    const q = sql`select count(*)::int as n from ad_metrics_daily m join campaigns c on c.id = m.campaign_id where c.platform = 'tiktok'`;
    const admin = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ad_metrics_daily m join campaigns c on c.id = m.campaign_id where c.platform = 'tiktok' and m.tenant_id = ${tenantA}::uuid`);
    expect(admin.rows[0]?.n).toBeGreaterThan(0);
    expect((await withTenant(tenantB, (tx) => tx.execute<{ n: number }>(q), pools.app)).rows[0]?.n).toBe(0);
    expect((await withTenant(tenantA, (tx) => tx.execute<{ n: number }>(q), pools.app)).rows[0]?.n).toBe(admin.rows[0]?.n);
  });
});
