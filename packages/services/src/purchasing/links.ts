import { createHash, randomBytes } from "node:crypto";
import { adminDb, and, desc, eq, isNull, recordAudit, schema, sql, type Database } from "@keel/db";
import { SUPPLIER_LINK_TTL_DAYS } from "@keel/config";
import { supplierLinkState, type SupplierLinkState } from "@keel/core";
import type { ServiceContext } from "../context";

/**
 * Supplier links: an unguessable token per purchase order, sent to the supplier. Only its SHA-256
 * is stored; a link expires after `SUPPLIER_LINK_TTL_DAYS`, can be revoked, and a resend issues a
 * new token and revokes the previous one. Every view or answer is logged.
 */
export const hashSupplierToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function issueSupplierLink(ctx: ServiceContext, poId: string, email: string | null, opts: { ttlDays?: number } = {}): Promise<{ token: string; linkId: string; expiresAt: Date; revoked: number }> {
  const token = randomBytes(24).toString("base64url");
  const now = ctx.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.ttlDays ?? SUPPLIER_LINK_TTL_DAYS) * 864e5);
  const revoked = await revokeSupplierLinks(ctx, poId);
  const [link] = await ctx.tx.insert(schema.supplierLinks).values({ tenantId: ctx.tenantId, purchaseOrderId: poId, tokenHash: hashSupplierToken(token), tokenHint: token.slice(-4), sentToEmail: email, expiresAt, createdBy: ctx.actor.userId, createdAt: now }).returning({ id: schema.supplierLinks.id });
  // the legacy plain-text column is cleared: links now live in supplier_links only
  await ctx.tx.update(schema.purchaseOrders).set({ supplierToken: null, sentToEmail: email, sentAt: now, orderedAt: sql`coalesce(${schema.purchaseOrders.orderedAt}, ${now})`, status: sql`case when ${schema.purchaseOrders.status} = 'draft' then 'sent' else ${schema.purchaseOrders.status} end` }).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId)));
  return { token, linkId: link!.id, expiresAt, revoked };
}

/** Revokes every active link of a PO (and a legacy token); returns how many were active. */
export async function revokeSupplierLinks(ctx: ServiceContext, poId: string): Promise<number> {
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.update(schema.supplierLinks).set({ revokedAt: now, revokedBy: ctx.actor.userId }).where(and(eq(schema.supplierLinks.tenantId, ctx.tenantId), eq(schema.supplierLinks.purchaseOrderId, poId), isNull(schema.supplierLinks.revokedAt), sql`${schema.supplierLinks.expiresAt} > ${now}`)).returning({ id: schema.supplierLinks.id });
  const legacy = await ctx.tx.update(schema.purchaseOrders).set({ supplierToken: null }).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId), sql`${schema.purchaseOrders.supplierToken} is not null`)).returning({ id: schema.purchaseOrders.id });
  return rows.length + legacy.length;
}

export interface ResolvedSupplierLink {
  tenantId: string;
  poId: string;
  /** null for a token issued before links were hashed (still in `purchase_orders.supplier_token`). */
  linkId: string | null;
  state: SupplierLinkState;
}

/**
 * Resolves the tenant and state of a supplier token. This is the only cross-tenant read of the
 * flow (the public page has no session); everything after it runs inside `withTenant`. A legacy
 * token expires `SUPPLIER_LINK_TTL_DAYS` after the PO was sent.
 */
export async function resolveSupplierToken(token: string, db?: Database, now = new Date()): Promise<ResolvedSupplierLink | null> {
  if (!token || token.length < 16 || token.length > 200) return null;
  const conn = db ?? adminDb();
  const [link] = await conn.select({ id: schema.supplierLinks.id, tenantId: schema.supplierLinks.tenantId, poId: schema.supplierLinks.purchaseOrderId, expiresAt: schema.supplierLinks.expiresAt, revokedAt: schema.supplierLinks.revokedAt }).from(schema.supplierLinks).where(eq(schema.supplierLinks.tokenHash, hashSupplierToken(token))).limit(1);
  if (link) return { tenantId: link.tenantId, poId: link.poId, linkId: link.id, state: supplierLinkState(link, now) };
  const [legacy] = await conn.select({ tenantId: schema.purchaseOrders.tenantId, poId: schema.purchaseOrders.id, sentAt: schema.purchaseOrders.sentAt, createdAt: schema.purchaseOrders.createdAt }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.supplierToken, token)).limit(1);
  if (!legacy) return null;
  return { tenantId: legacy.tenantId, poId: legacy.poId, linkId: null, state: supplierLinkState({ expiresAt: legacyExpiry(legacy.sentAt ?? legacy.createdAt), revokedAt: null }, now) };
}

const legacyExpiry = (sentAt: Date) => new Date(sentAt.getTime() + SUPPLIER_LINK_TTL_DAYS * 864e5);

/**
 * Writes the access log row for a view or an answer attempt (inside the link's tenant), bumps the
 * link's counters, and audits blocked accesses. A legacy token is moved to `supplier_links` (hashed)
 * on first use. Returns the link id.
 */
export async function recordSupplierLinkAccess(ctx: ServiceContext, resolved: ResolvedSupplierLink, input: { token: string; kind: "view" | "answer"; ip?: string | null; userAgent?: string | null }): Promise<string> {
  const now = ctx.now ?? new Date();
  let linkId = resolved.linkId;
  if (!linkId) {
    const [po] = await ctx.tx.select({ sentAt: schema.purchaseOrders.sentAt, createdAt: schema.purchaseOrders.createdAt, email: schema.purchaseOrders.sentToEmail }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, resolved.poId))).limit(1);
    const sent = po?.sentAt ?? po?.createdAt ?? now;
    const [row] = await ctx.tx.insert(schema.supplierLinks).values({ tenantId: ctx.tenantId, purchaseOrderId: resolved.poId, tokenHash: hashSupplierToken(input.token), tokenHint: input.token.slice(-4), sentToEmail: po?.email ?? null, expiresAt: legacyExpiry(sent), createdAt: sent }).onConflictDoNothing().returning({ id: schema.supplierLinks.id });
    linkId = row?.id ?? (await ctx.tx.select({ id: schema.supplierLinks.id }).from(schema.supplierLinks).where(eq(schema.supplierLinks.tokenHash, hashSupplierToken(input.token))).limit(1))[0]!.id;
    await ctx.tx.update(schema.purchaseOrders).set({ supplierToken: null }).where(eq(schema.purchaseOrders.id, resolved.poId));
  }
  await ctx.tx.insert(schema.supplierLinkViews).values({ tenantId: ctx.tenantId, linkId, purchaseOrderId: resolved.poId, kind: input.kind, outcome: resolved.state, ipHash: input.ip ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32) : null, userAgent: input.userAgent?.slice(0, 200) ?? null, createdAt: now });
  await ctx.tx.update(schema.supplierLinks).set({ lastViewedAt: now, viewCount: sql`${schema.supplierLinks.viewCount} + 1` }).where(eq(schema.supplierLinks.id, linkId));
  if (resolved.state !== "active") await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "purchase_order.supplier_link_blocked", entityType: "purchase_order", entityId: resolved.poId, metadata: { linkId, outcome: resolved.state, kind: input.kind } });
  return linkId;
}

export interface SupplierLinkRow {
  id: string;
  tokenHint: string | null;
  sentToEmail: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  state: SupplierLinkState;
}

/** Links of a PO, newest first, with their state now. */
export async function listSupplierLinks(ctx: ServiceContext, poId: string): Promise<SupplierLinkRow[]> {
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.select().from(schema.supplierLinks).where(and(eq(schema.supplierLinks.tenantId, ctx.tenantId), eq(schema.supplierLinks.purchaseOrderId, poId))).orderBy(desc(schema.supplierLinks.createdAt));
  return rows.map((r) => ({ id: r.id, tokenHint: r.tokenHint, sentToEmail: r.sentToEmail, createdAt: r.createdAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt, lastViewedAt: r.lastViewedAt, viewCount: r.viewCount, state: supplierLinkState(r, now) }));
}
