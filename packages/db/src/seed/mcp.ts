import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** A stored hash no presented token can match (the server stores HMACs of real tokens). */
const fakeHash = (s: string) => createHash("sha256").update(`seed-mcp:${s}`).digest("hex");

/**
 * MCP demo (#21), Northwind only (Growth plan; Harbor Home's Starter plan has no MCP): MCP switched
 * on, Claude connected over OAuth by the owner, a personal access token for operations, two weeks of
 * request log, one proposal waiting for approval and one already rejected. Idempotent: the tenant's
 * MCP rows are rewritten. Nothing here is a working secret.
 */
export async function seedMcp(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  for (const table of [schema.mcpTokens, schema.mcpAuthorizationCodes, schema.mcpRequestLog, schema.mcpRateBuckets, schema.mcpPendingActions]) await db.delete(table).where(eq(table.tenantId, tenantId));
  if (key !== "northwind") return;
  await enableDemoMcp(db, tenantId);
  const owner = userIds["owner@northwind.demo"]!;
  const ops = userIds["ops@northwind.demo"] ?? owner;
  const at = (hours: number) => new Date(now.getTime() - hours * 3600e3);
  const [client] = await db
    .insert(schema.oauthClients)
    .values({ clientId: "kc_demo_claude", clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], clientUri: "https://claude.ai", createdAt: at(24 * 12), lastUsedAt: at(2) })
    .onConflictDoUpdate({ target: schema.oauthClients.clientId, set: { lastUsedAt: at(2) } })
    .returning({ id: schema.oauthClients.id });
  const [claude] = await db
    .insert(schema.mcpTokens)
    .values({ tenantId, userId: owner, kind: "oauth", clientId: client!.id, name: "Claude", displayPrefix: "kat_Dm0c", accessHash: fakeHash(`${tenantId}:claude:access`), refreshHash: fakeHash(`${tenantId}:claude:refresh`), scopes: ["read", "write:notes"], resource: null, expiresAt: at(-1), refreshExpiresAt: at(-24 * 18), rotatedAt: at(1), lastUsedAt: at(2), createdAt: at(24 * 12), updatedAt: at(1) })
    .returning({ id: schema.mcpTokens.id });
  const [pat] = await db
    .insert(schema.mcpTokens)
    .values({ tenantId, userId: ops, kind: "pat", name: "Cursor (laptop)", displayPrefix: "kpat_7Hq2", accessHash: fakeHash(`${tenantId}:cursor:pat`), scopes: ["read"], expiresAt: at(-24 * 60), rotatedAt: at(24 * 30), lastUsedAt: at(26), createdAt: at(24 * 30), updatedAt: at(24 * 30) })
    .returning({ id: schema.mcpTokens.id });
  await db.insert(schema.mcpTokens).values({ tenantId, userId: owner, kind: "pat", name: "Old script", displayPrefix: "kpat_x91L", accessHash: fakeHash(`${tenantId}:old:pat`), scopes: ["read"], expiresAt: at(-24 * 20), rotatedAt: at(24 * 70), lastUsedAt: at(24 * 40), revokedAt: at(24 * 35), revokedBy: owner, createdAt: at(24 * 70), updatedAt: at(24 * 35) });
  await db.insert(schema.mcpAuthorizationCodes).values({ tenantId, userId: owner, clientId: client!.id, codeHash: fakeHash(`${tenantId}:code`), redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "seed-challenge-not-usable", scopes: ["read", "write:notes"], expiresAt: at(24 * 12 - 0.05), usedAt: at(24 * 12), createdAt: at(24 * 12) });
  const tools = ["get_kpis", "search_orders", "get_order", "get_campaigns", "get_stock_risk", "get_profit_and_loss", "list_products", "lookup_customers", "list_returns", "get_integration_health"];
  const log: (typeof schema.mcpRequestLog.$inferInsert)[] = [];
  for (let i = 0; i < 90; i++) {
    const viaClaude = i % 3 !== 0;
    const outcome = i % 29 === 7 ? "rate_limited" : i % 17 === 5 ? "invalid_input" : i % 23 === 11 ? "denied" : "ok";
    log.push({ tenantId, tokenId: viaClaude ? claude!.id : pat!.id, userId: viaClaude ? owner : ops, clientName: viaClaude ? "Claude" : "Cursor (laptop)", method: i % 10 === 0 ? "tools/list" : "tools/call", tool: i % 10 === 0 ? null : tools[i % tools.length], outcome, errorCode: outcome === "ok" ? null : outcome, durationMs: 40 + ((i * 37) % 400), createdAt: at(2 + i * 3.7) });
  }
  log.push({ tenantId, method: "auth", outcome: "auth_failed", errorCode: "expired_token", durationMs: 3, createdAt: at(30) });
  await db.insert(schema.mcpRequestLog).values(log);
  await db.insert(schema.mcpRateBuckets).values({ tenantId, bucket: "tenant", windowStart: new Date(Math.floor(at(2).getTime() / 60_000) * 60_000), count: 3 });
  const orders = await db.select({ id: schema.orders.id, name: schema.orders.name, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.status, ["new", "pending_review", "confirmed"]))).orderBy(desc(schema.orders.placedAt)).limit(2);
  for (const [i, o] of orders.entries()) {
    const pending = i === 0;
    await db.insert(schema.mcpPendingActions).values({ tenantId, kind: "order.cancel", entityType: "order", entityId: o.id, summary: { orderName: o.name, totalMinor: o.totalMinor, currency: o.currency, restock: true, refund: true }, payload: { orderId: o.id, reason: pending ? "Customer asked to cancel by email" : "Duplicate of an earlier order", restock: true, refund: true }, reason: pending ? "The customer wrote that they ordered the wrong colour and want to cancel." : "Looks like a duplicate of the order placed ten minutes earlier.", status: pending ? "pending" : "rejected", requestedBy: owner, tokenId: claude!.id, clientName: "Claude", decidedBy: pending ? null : owner, decidedAt: pending ? null : at(20), decisionNote: pending ? null : "Not a duplicate: two different addresses.", expiresAt: new Date(now.getTime() + 7 * 864e5), createdAt: at(pending ? 3 : 22), updatedAt: at(pending ? 3 : 20) });
  }
}

/** Northwind has MCP switched on (opt-in setting), PII masked. Only adds the key when missing. */
export async function enableDemoMcp(db: Db, tenantId: string): Promise<boolean> {
  const r = await db.execute<{ id: string }>(sql`update tenants set settings = '{"mcpEnabled": true}'::jsonb || coalesce(settings, '{}'::jsonb) where id = ${tenantId} and not (coalesce(settings, '{}'::jsonb) ? 'mcpEnabled') returning id`);
  return r.rows.length > 0;
}
