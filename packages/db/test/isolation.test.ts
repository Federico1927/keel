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

const PLATFORM_TABLES = new Set(["users", "accounts", "sessions", "verification_tokens", "tenants", "tenant_memberships", "tenant_addons"]);
/** Tenant tables the seed may legitimately leave empty for one tenant. */
const EMPTY_ALLOWED = new Set<string>(["tenant_addons"]);
/** Add-on tables: only tenants with the add-on carry rows, so the seed populates tenant A alone. */
const ADDON_ONLY = new Set<string>(["cod_settings", "cod_queue_items", "cod_attempts", "cod_operator_capacity", "cod_capacity_exceptions", "cod_assignment_log", "cod_recipient_profiles", "retention_campaigns", "retention_exposures"]);

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
    expect(r.rows[0]?.a, `${name}: no rows for tenant A`).toBeGreaterThan(0);
    if (!ADDON_ONLY.has(name)) expect(r.rows[0]?.b, `${name}: no rows for tenant B`).toBeGreaterThan(0);
  });

  it("tenant A sees exactly its rows, tenant B none of A's", async () => {
    const adminCount = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${tenantA}::uuid`);
    const asA = await withTenant(tenantA, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)}`), pools.app);
    const asBCross = await withTenant(
      tenantB,
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${tenantA}::uuid`),
      pools.app,
    );
    const asBOwn = await withTenant(tenantB, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id <> ${tenantB}::uuid`), pools.app);
    expect(asA.rows[0]?.n).toBe(adminCount.rows[0]?.n);
    expect(asBCross.rows[0]?.n).toBe(0);
    expect(asBOwn.rows[0]?.n).toBe(0);
  });

  it("tenant B cannot update or delete tenant A rows", async () => {
    const upd = await withTenant(tenantB, (tx) => tx.execute(sql`update ${sql.identifier(name)} set tenant_id = tenant_id where tenant_id = ${tenantA}::uuid`), pools.app);
    expect(upd.rowCount ?? 0).toBe(0);
    const del = await withTenant(tenantB, (tx) => tx.execute(sql`delete from ${sql.identifier(name)} where tenant_id = ${tenantA}::uuid`), pools.app);
    expect(del.rowCount ?? 0).toBe(0);
    // Nothing changed for A.
    const stillThere = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where tenant_id = ${tenantA}::uuid`);
    expect(stillThere.rows[0]?.n).toBeGreaterThan(0);
  });

  it("tenant B cannot insert a row for tenant A", async () => {
    const sample = await pools.admin.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(t) as row from ${sql.identifier(name)} t where tenant_id = ${tenantA}::uuid limit 1`);
    const row = sample.rows[0]?.row;
    if (!row) return;
    const clone = { ...row, id: crypto.randomUUID() };
    // Generated columns cannot be inserted explicitly: list the writable ones.
    const cols = await pools.admin.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${name} and is_generated = 'NEVER' order by ordinal_position`);
    const colList = sql.join(cols.rows.map((c) => sql.identifier(c.column_name)), sql`, `);
    await expect(
      withTenant(
        tenantB,
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
