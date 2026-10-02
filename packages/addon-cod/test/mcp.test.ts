import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, schema, withTenant, type Database } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MCP_CORE_TOOLS, createMcpServer, createPersonalAccessToken, resolveMcpBearer, type McpDeps } from "@hullwise/services";
import { COD_MCP_TOOLS } from "../src";

const pools = testPools();
const deps: McpDeps = { admin: pools.admin as unknown as Database, app: pools.app as unknown as Database };
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(async () => {
  await pools.admin.update(schema.tenantAddons).set({ isActive: true }).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, "addon.cod")));
  await pools.close();
});

async function client(): Promise<Client> {
  const userId = ctx.userIds["owner@northwind.demo"]!;
  const issued = await withTenant(tenantId, (tx) => createPersonalAccessToken({ tenantId, tx, actor: { type: "user", userId } }, { userId, name: "cod test", scopes: ["read"], days: 7 }), pools.app);
  const auth = await resolveMcpBearer(deps, issued.token);
  if (!auth.ok) throw new Error(auth.code);
  const server = createMcpServer({ deps, principal: auth.principal, tools: [...MCP_CORE_TOOLS, ...COD_MCP_TOOLS], linkBase: "https://hullwise.test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "vitest", version: "1" });
  await c.connect(ct);
  return c;
}

describe("COD tools through MCP", () => {
  it("are listed and run with the add-on; without it they are neither listed nor callable", async () => {
    const on = await client();
    expect((await on.listTools()).tools.map((t) => t.name)).toContain("get_cod_queue");
    const r = (await on.callTool({ name: "get_cod_queue", arguments: { limit: 5 } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(r.content[0]!.text) as { counts: Record<string, number>; items: { phone: string | null }[] };
    expect(data.counts).toHaveProperty("unassigned");
    for (const i of data.items) if (i.phone) expect(i.phone).toMatch(/^•••\d{4}$|^•••$/);

    await pools.admin.update(schema.tenantAddons).set({ isActive: false }).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, "addon.cod")));
    const off = await client();
    expect((await off.listTools()).tools.map((t) => t.name)).not.toContain("get_cod_queue");
    const refused = (await off.callTool({ name: "get_cod_queue", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("not active");
  });
});
