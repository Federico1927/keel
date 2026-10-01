import { and, asc, desc, eq, inArray, recordAudit, schema, sql, withTenant, type Database, type SQL } from "@keel/db";
import { SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_TYPES } from "@keel/config";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";

export const SUPPORT_CATEGORIES = ["question", "problem", "billing", "feature"] as const;
export const SUPPORT_STATUSES = ["open", "answered", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export class SupportError extends Error {
  constructor(public code: "not_found" | "invalid_input" | "attachment_too_large" | "attachment_type" | "closed") {
    super(code);
    this.name = "SupportError";
  }
}

export interface SupportAttachment {
  name: string;
  type: string;
  data: Buffer;
}

function checkAttachment(a: SupportAttachment | null | undefined) {
  if (!a) return null;
  if (a.data.length > SUPPORT_ATTACHMENT_MAX_BYTES) throw new SupportError("attachment_too_large");
  if (!(SUPPORT_ATTACHMENT_TYPES as readonly string[]).includes(a.type)) throw new SupportError("attachment_type");
  return { attachmentName: a.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "attachment", attachmentType: a.type, attachmentSize: a.data.length, attachmentData: a.data };
}
function checkBody(body: string) {
  const b = body.trim();
  if (!b || b.length > 8000) throw new SupportError("invalid_input");
  return b;
}
const messageColumns = { id: schema.supportMessages.id, ticketId: schema.supportMessages.ticketId, authorId: schema.supportMessages.authorId, side: schema.supportMessages.side, body: schema.supportMessages.body, attachmentName: schema.supportMessages.attachmentName, attachmentType: schema.supportMessages.attachmentType, attachmentSize: schema.supportMessages.attachmentSize, createdAt: schema.supportMessages.createdAt, authorName: schema.users.name, authorEmail: schema.users.email };

/* ---------- tenant side (RLS) ---------- */

export async function openSupportTicket(ctx: ServiceContext, input: { subject: string; category: string; body: string; attachment?: SupportAttachment | null }): Promise<{ id: string; number: number }> {
  const subject = input.subject.trim();
  if (!subject || subject.length > 160 || !(SUPPORT_CATEGORIES as readonly string[]).includes(input.category)) throw new SupportError("invalid_input");
  const body = checkBody(input.body);
  const att = checkAttachment(input.attachment);
  const now = ctx.now ?? new Date();
  const [max] = await ctx.tx.select({ n: sql<number>`coalesce(max(${schema.supportTickets.number}), 0)::int` }).from(schema.supportTickets).where(eq(schema.supportTickets.tenantId, ctx.tenantId));
  const number = (max?.n ?? 0) + 1;
  const [t] = await ctx.tx.insert(schema.supportTickets).values({ tenantId: ctx.tenantId, number, subject, category: input.category, status: "open", createdBy: ctx.actor.userId, lastMessageAt: now, createdAt: now, updatedAt: now }).returning({ id: schema.supportTickets.id });
  await ctx.tx.insert(schema.supportMessages).values({ tenantId: ctx.tenantId, ticketId: t!.id, authorId: ctx.actor.userId, side: "tenant", body, ...(att ?? {}), createdAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "support.ticket_opened", entityType: "support_ticket", entityId: t!.id, diff: { status: { from: null, to: "open" } }, metadata: { number, subject, category: input.category, attachment: att ? { name: att.attachmentName, size: att.attachmentSize } : null } });
  return { id: t!.id, number };
}

export async function replyToTicket(ctx: ServiceContext, ticketId: string, input: { body: string; attachment?: SupportAttachment | null }): Promise<void> {
  const [t] = await ctx.tx.select().from(schema.supportTickets).where(and(eq(schema.supportTickets.tenantId, ctx.tenantId), eq(schema.supportTickets.id, ticketId))).limit(1);
  if (!t) throw new SupportError("not_found");
  const body = checkBody(input.body);
  const att = checkAttachment(input.attachment);
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.supportMessages).values({ tenantId: ctx.tenantId, ticketId, authorId: ctx.actor.userId, side: "tenant", body, ...(att ?? {}), createdAt: now });
  await ctx.tx.update(schema.supportTickets).set({ status: "open", lastMessageAt: now, closedAt: null, updatedAt: now }).where(eq(schema.supportTickets.id, ticketId));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "support.tenant_replied", entityType: "support_ticket", entityId: ticketId, diff: t.status !== "open" ? { status: { from: t.status, to: "open" } } : {}, metadata: { attachment: att ? { name: att.attachmentName, size: att.attachmentSize } : null } });
}

export async function closeTicket(ctx: ServiceContext, ticketId: string): Promise<void> {
  const [t] = await ctx.tx.select().from(schema.supportTickets).where(and(eq(schema.supportTickets.tenantId, ctx.tenantId), eq(schema.supportTickets.id, ticketId))).limit(1);
  if (!t) throw new SupportError("not_found");
  if (t.status === "closed") return;
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.supportTickets).set({ status: "closed", closedAt: now, updatedAt: now }).where(eq(schema.supportTickets.id, ticketId));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "support.ticket_closed", entityType: "support_ticket", entityId: ticketId, diff: { status: { from: t.status, to: "closed" } } });
}

export async function listSupportTickets(ctx: ServiceContext, f: { status?: string } = {}) {
  const conds: SQL[] = [eq(schema.supportTickets.tenantId, ctx.tenantId)];
  if (f.status && (SUPPORT_STATUSES as readonly string[]).includes(f.status)) conds.push(eq(schema.supportTickets.status, f.status));
  return ctx.tx.select({ t: schema.supportTickets, authorName: schema.users.name, authorEmail: schema.users.email, messages: sql<number>`(select count(*) from support_messages m where m.ticket_id = ${schema.supportTickets.id})::int` }).from(schema.supportTickets).leftJoin(schema.users, eq(schema.users.id, schema.supportTickets.createdBy)).where(and(...conds)).orderBy(desc(schema.supportTickets.lastMessageAt)).limit(200);
}

export async function supportTicketThread(ctx: ServiceContext, ticketId: string) {
  const [t] = await ctx.tx.select().from(schema.supportTickets).where(and(eq(schema.supportTickets.tenantId, ctx.tenantId), eq(schema.supportTickets.id, ticketId))).limit(1);
  if (!t) return null;
  const messages = await ctx.tx.select(messageColumns).from(schema.supportMessages).leftJoin(schema.users, eq(schema.users.id, schema.supportMessages.authorId)).where(eq(schema.supportMessages.ticketId, ticketId)).orderBy(asc(schema.supportMessages.createdAt));
  return { ticket: t, messages };
}

export async function supportAttachment(ctx: ServiceContext, messageId: string) {
  const [m] = await ctx.tx.select({ name: schema.supportMessages.attachmentName, type: schema.supportMessages.attachmentType, data: schema.supportMessages.attachmentData }).from(schema.supportMessages).where(and(eq(schema.supportMessages.tenantId, ctx.tenantId), eq(schema.supportMessages.id, messageId))).limit(1);
  return m?.data ? { name: m.name ?? "attachment", type: m.type ?? "application/octet-stream", data: m.data } : null;
}

/* ---------- platform side (admin connection, audited) ---------- */

export async function adminListSupportTickets(db: Database, f: { status?: string; tenantId?: string } = {}) {
  const conds: SQL[] = [];
  if (f.status && (SUPPORT_STATUSES as readonly string[]).includes(f.status)) conds.push(eq(schema.supportTickets.status, f.status));
  if (f.tenantId) conds.push(eq(schema.supportTickets.tenantId, f.tenantId));
  const rows = await db.select({ t: schema.supportTickets, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug, authorEmail: schema.users.email, messages: sql<number>`(select count(*) from support_messages m where m.ticket_id = ${schema.supportTickets.id})::int` }).from(schema.supportTickets).innerJoin(schema.tenants, eq(schema.tenants.id, schema.supportTickets.tenantId)).leftJoin(schema.users, eq(schema.users.id, schema.supportTickets.createdBy)).where(conds.length ? and(...conds) : undefined).orderBy(sql`case ${schema.supportTickets.status} when 'open' then 0 when 'answered' then 1 else 2 end`, desc(schema.supportTickets.lastMessageAt)).limit(300);
  const [counts] = await db.select({ open: sql<number>`count(*) filter (where status = 'open')::int`, answered: sql<number>`count(*) filter (where status = 'answered')::int`, closed: sql<number>`count(*) filter (where status = 'closed')::int` }).from(schema.supportTickets);
  return { rows, counts: counts ?? { open: 0, answered: 0, closed: 0 } };
}

export async function adminSupportThread(db: Database, ticketId: string) {
  const [t] = await db.select({ t: schema.supportTickets, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug, authorEmail: schema.users.email }).from(schema.supportTickets).innerJoin(schema.tenants, eq(schema.tenants.id, schema.supportTickets.tenantId)).leftJoin(schema.users, eq(schema.users.id, schema.supportTickets.createdBy)).where(eq(schema.supportTickets.id, ticketId)).limit(1);
  if (!t) return null;
  const messages = await db.select(messageColumns).from(schema.supportMessages).leftJoin(schema.users, eq(schema.users.id, schema.supportMessages.authorId)).where(eq(schema.supportMessages.ticketId, ticketId)).orderBy(asc(schema.supportMessages.createdAt));
  return { ...t, messages };
}

type TenantRunner = <T>(tenantId: string, fn: (tx: ServiceContext["tx"]) => Promise<T>) => Promise<T>;
const defaultRunner: TenantRunner = (tenantId, fn) => withTenant(tenantId, fn);

/**
 * The super-admin answers: message and status through the admin connection, an audit row on the
 * tenant (`super_admin`), and the ticket author notified inside the tenant's own transaction
 * (in-app and email per their preferences).
 */
export async function adminReplyToTicket(db: Database, ticketId: string, adminUserId: string, input: { body: string; attachment?: SupportAttachment | null; close?: boolean }, opts: { now?: Date; runInTenant?: TenantRunner } = {}): Promise<void> {
  const [t] = await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.id, ticketId)).limit(1);
  if (!t) throw new SupportError("not_found");
  const body = checkBody(input.body);
  const att = checkAttachment(input.attachment);
  const now = opts.now ?? new Date();
  const status: SupportStatus = input.close ? "closed" : "answered";
  await db.insert(schema.supportMessages).values({ tenantId: t.tenantId, ticketId, authorId: adminUserId, side: "platform", body, ...(att ?? {}), createdAt: now });
  await db.update(schema.supportTickets).set({ status, lastMessageAt: now, closedAt: input.close ? now : null, updatedAt: now }).where(eq(schema.supportTickets.id, ticketId));
  await recordAudit(db, { tenantId: t.tenantId, actorUserId: adminUserId, actorType: "super_admin", action: "support.platform_replied", entityType: "support_ticket", entityId: ticketId, diff: t.status !== status ? { status: { from: t.status, to: status } } : {}, metadata: { number: t.number, attachment: att ? { name: att.attachmentName, size: att.attachmentSize } : null } });
  if (t.createdBy) {
    const run = opts.runInTenant ?? defaultRunner;
    await run(t.tenantId, (tx) => notifyUsers({ tenantId: t.tenantId, tx, actor: { type: "system", userId: null }, now }, { userIds: [t.createdBy!], type: "support_reply", title: `#${t.number} · ${t.subject}`, body: body.length > 140 ? `${body.slice(0, 137)}…` : body, link: `/support/${ticketId}`, metadata: { ticketId } }));
  }
}

export async function adminSetTicketStatus(db: Database, ticketId: string, adminUserId: string, status: SupportStatus, now = new Date()): Promise<void> {
  const [t] = await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.id, ticketId)).limit(1);
  if (!t) throw new SupportError("not_found");
  if (t.status === status) return;
  await db.update(schema.supportTickets).set({ status, closedAt: status === "closed" ? now : null, updatedAt: now }).where(eq(schema.supportTickets.id, ticketId));
  await recordAudit(db, { tenantId: t.tenantId, actorUserId: adminUserId, actorType: "super_admin", action: "support.status_changed", entityType: "support_ticket", entityId: ticketId, diff: { status: { from: t.status, to: status } } });
}

/** Reading a tenant's file from the console is itself an audited action. */
export async function adminSupportAttachment(db: Database, messageId: string, adminUserId: string) {
  const [m] = await db.select({ tenantId: schema.supportMessages.tenantId, ticketId: schema.supportMessages.ticketId, name: schema.supportMessages.attachmentName, type: schema.supportMessages.attachmentType, data: schema.supportMessages.attachmentData }).from(schema.supportMessages).where(eq(schema.supportMessages.id, messageId)).limit(1);
  if (!m?.data) return null;
  await recordAudit(db, { tenantId: m.tenantId, actorUserId: adminUserId, actorType: "super_admin", action: "support.attachment_viewed", entityType: "support_ticket", entityId: m.ticketId, metadata: { messageId, name: m.name } });
  return { name: m.name ?? "attachment", type: m.type ?? "application/octet-stream", data: m.data };
}

/** Open tickets per tenant, for the console's tenant list. */
export async function openTicketCounts(db: Database, tenantIds: string[]): Promise<Map<string, number>> {
  if (!tenantIds.length) return new Map();
  const rows = await db.select({ tenantId: schema.supportTickets.tenantId, n: sql<number>`count(*)::int` }).from(schema.supportTickets).where(and(inArray(schema.supportTickets.tenantId, tenantIds), eq(schema.supportTickets.status, "open"))).groupBy(schema.supportTickets.tenantId);
  return new Map(rows.map((r) => [r.tenantId, r.n]));
}
