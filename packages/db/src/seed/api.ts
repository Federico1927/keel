import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { encryptSecret } from "@hullwise/integrations";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** A stored hash no presented token can match (the server stores HMACs of real tokens). */
const fakeHash = (s: string) => createHash("sha256").update(`seed-api:${s}`).digest("hex");

/**
 * REST API and outgoing webhooks demo (#81), Northwind only (Growth plan; Harbor Home's Starter
 * plan has no API): an "ERP sync" token of the owner with API scopes, two weeks of request log, an
 * ERP endpoint with its order and shipment deliveries (mostly delivered, one cancelled, one dead and
 * redelivered) and a stock endpoint. Both endpoints are paused and on reserved `.example` hosts, and
 * no delivery is left due, so the demo (and every e2e run on it) never calls out by itself. Nothing
 * here is a working secret: the endpoint secrets are random and never shown. Idempotent.
 */
export async function seedApi(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  for (const table of [schema.webhookEndpoints, schema.apiRequestLog, schema.apiIdempotencyKeys]) await db.delete(table).where(eq(table.tenantId, tenantId));
  if (key !== "northwind") return;
  const owner = userIds["owner@northwind.demo"]!;
  const at = (hours: number) => new Date(now.getTime() - hours * 3600e3);
  const secret = (label: string) => (process.env.APP_ENCRYPTION_KEY ? encryptSecret(`whsec_seed${createHash("sha256").update(`${tenantId}:${label}:${randomUUID()}`).digest("hex").slice(0, 28)}`) : "seed-secret-not-decryptable");

  // the MCP step rewrites the tenant's tokens; run alone, this step replaces only its own
  await db.delete(schema.mcpTokens).where(and(eq(schema.mcpTokens.tenantId, tenantId), eq(schema.mcpTokens.accessHash, fakeHash(`${tenantId}:erp`))));
  const [token] = await db
    .insert(schema.mcpTokens)
    .values({ tenantId, userId: owner, kind: "pat", name: "ERP sync", displayPrefix: "kpat_Er9p", accessHash: fakeHash(`${tenantId}:erp`), scopes: ["orders:read", "orders:write", "products:read", "inventory:read", "inventory:write", "webhooks:manage"], expiresAt: at(-24 * 150), rotatedAt: at(24 * 30), lastUsedAt: at(0.4), createdAt: at(24 * 30), updatedAt: at(24 * 30) })
    .returning({ id: schema.mcpTokens.id });

  const routes = [["GET", "/v1/orders", 200], ["GET", "/v1/orders/{id}", 200], ["GET", "/v1/inventory-levels", 200], ["POST", "/v1/inventory-levels/adjust", 200], ["GET", "/v1/products", 200], ["POST", "/v1/orders/{id}/notes", 201], ["GET", "/v1/orders", 429], ["POST", "/v1/orders/{id}/status", 409], ["GET", "/v1/customers", 403]] as const;
  const log: (typeof schema.apiRequestLog.$inferInsert)[] = [];
  for (let i = 0; i < 60; i++) {
    const r = i % 23 === 7 ? routes[6] : i % 29 === 11 ? routes[7] : i % 31 === 3 ? routes[8] : routes[i % 6]!;
    log.push({ tenantId, tokenId: token!.id, userId: owner, method: r[0], route: r[1], status: r[2], errorCode: r[2] === 429 ? "rate_limited" : r[2] === 409 ? "conflict" : r[2] === 403 ? "insufficient_scope" : null, durationMs: 30 + ((i * 41) % 260), createdAt: at(0.4 + i * 5.3) });
  }
  await db.insert(schema.apiRequestLog).values(log);
  await db.insert(schema.apiIdempotencyKeys).values({ tenantId, tokenId: token!.id, key: "erp-adjust-20261001-0007", method: "POST", path: "/v1/inventory-levels/adjust", requestHash: fakeHash("idem"), responseStatus: 200, responseBody: { object: "inventory_adjustment", before: 14, after: 12 }, createdAt: at(3), expiresAt: at(-21) });

  const [erp] = await db
    .insert(schema.webhookEndpoints)
    .values({ tenantId, url: "https://erp.example/webhooks/orders", description: "ERP: orders and shipments (paused)", secretEnc: secret("erp"), secretPrefix: "whsec_Q7ka", eventTypes: ["order.created", "order.status_changed", "shipment.updated"], isActive: false, createdBy: owner, secretRotatedAt: at(24 * 20), lastSuccessAt: at(0.5), lastFailureAt: at(9), createdAt: at(24 * 20), updatedAt: at(24 * 20) })
    .returning({ id: schema.webhookEndpoints.id });
  await db.insert(schema.webhookEndpoints).values({ tenantId, url: "https://purchasing.example/hooks/stock", description: "Purchasing tool: low stock (paused)", secretEnc: secret("stock"), secretPrefix: "whsec_m2Tt", eventTypes: ["inventory.low_stock", "product.updated"], isActive: false, createdBy: owner, secretRotatedAt: at(24 * 9), lastSuccessAt: at(24 * 3), createdAt: at(24 * 9), updatedAt: at(24 * 2) });

  const orders = await db.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.status, ["new", "confirmed", "fulfilling", "shipped", "delivered"]))).orderBy(desc(schema.orders.placedAt)).limit(24);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const rows: (typeof schema.webhookDeliveries.$inferInsert)[] = [];
  for (const [i, o] of orders.entries()) {
    const type = i % 3 === 0 ? "order.created" : i % 3 === 1 ? "order.status_changed" : "shipment.updated";
    const created = at(0.5 + i * 2.1);
    const eventId = randomUUID();
    const order = { id: o.id, object: "order", name: o.name, number: o.orderNumber, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, currency: o.currency, totalMinor: o.totalMinor, customerId: o.customerId, shippingCountry: o.shippingCountry, placedAt: iso(o.placedAt), updatedAt: iso(o.updatedAt) };
    const data = type === "order.status_changed" ? { order, previousStatus: "new", status: o.status, reason: "rules" } : type === "shipment.updated" ? { shipment: { orderId: o.id, status: "in_transit", carrier: "Carrier", trackingNumber: `TRK${o.orderNumber}` }, previousStatus: null } : { order };
    const payload = { id: eventId, type, apiVersion: "v1", createdAt: created.toISOString(), data };
    const base = { tenantId, endpointId: erp!.id, eventId, eventType: type, payload, createdAt: created, updatedAt: created };
    const ok = (minutesLater: number, ms: number) => ({ status: "succeeded", attempts: 1, responseCode: 200, durationMs: ms, responseExcerpt: "ok", deliveredAt: new Date(created.getTime() + minutesLater * 60e3), attemptLog: [{ at: new Date(created.getTime() + minutesLater * 60e3).toISOString(), code: 200, durationMs: ms, error: null }] });
    if (i === 1) {
      // answered 503 twice, then cancelled when the ERP endpoint was paused for maintenance (the demo never leaves a delivery due: no call goes out by itself)
      rows.push({ ...base, status: "cancelled", attempts: 2, responseCode: 503, durationMs: 412, lastError: "endpoint_disabled", responseExcerpt: "Service Unavailable", attemptLog: [{ at: created.toISOString(), code: 503, durationMs: 380, error: "http 503" }, { at: new Date(created.getTime() + 10e3).toISOString(), code: 503, durationMs: 412, error: "http 503" }] });
    } else if (i === 4) {
      // dead after the whole schedule (the ERP was down for the night), then redelivered by the owner
      const log = [10, 30, 120, 600, 1800, 3600, 7200].reduce<{ t: number; entries: { at: string; code: number | null; durationMs: number; error: string | null }[] }>((acc, delay) => ({ t: acc.t + delay * 1000, entries: [...acc.entries, { at: new Date(acc.t + delay * 1000).toISOString(), code: null, durationMs: 10_000, error: "timeout" }] }), { t: created.getTime(), entries: [{ at: created.toISOString(), code: null, durationMs: 10_000, error: "timeout" }] });
      const [dead] = await db.insert(schema.webhookDeliveries).values({ ...base, status: "dead", attempts: 8, responseCode: null, durationMs: 10_000, lastError: "timeout", attemptLog: log.entries.slice(-10) }).returning({ id: schema.webhookDeliveries.id });
      const later = new Date(created.getTime() + 4 * 3600e3);
      rows.push({ ...base, ...ok(0.1, 95), redeliveryOf: dead!.id, requestedBy: owner, createdAt: later, updatedAt: later, deliveredAt: later });
    } else rows.push({ ...base, ...ok(0.05, 60 + ((i * 37) % 180)) });
  }
  if (rows.length) await db.insert(schema.webhookDeliveries).values(rows);
}
