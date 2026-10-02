import { and, desc, eq, inArray, recordAudit, schema, sql } from "@hullwise/db";
import { MCP_LIMITS, canDo, canWritePage, isTenantRole, type ActionKey, type TenantRole } from "@hullwise/config";
import { sanitizeFreeText } from "@hullwise/core";
import type { CommercePlatform } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";
import { cancelOrderWithPlatform } from "../orders/writes";
import { refundOrder } from "../payments";
import { createPurchaseOrder, type PoLineInput } from "../purchasing";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";
import type { ToolRuntime } from "../tools";

/**
 * Proposals (#21): risky actions an AI client asks for through MCP. Nothing changes until a person
 * whose role allows the action approves it in Hullwise; the approval runs the same services the pages
 * use, as that person, with the proposal in the event metadata. Every step is audited.
 */

export const PROPOSAL_KINDS = ["order.cancel", "order.refund", "campaign.pause", "purchase_order.create"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** The permission a person needs to approve a proposal (purchase orders: write access to purchasing). */
export const PROPOSAL_ACTION: Record<ProposalKind, ActionKey | null> = { "order.cancel": "cancel_order", "order.refund": "refund_order", "campaign.pause": "pause_campaign", "purchase_order.create": null };

export function canApproveProposal(role: TenantRole, kind: string): boolean {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) return false;
  const action = PROPOSAL_ACTION[kind as ProposalKind];
  return action ? canDo(role, action) : canWritePage(role, "purchasing");
}

export interface ProposalInput {
  kind: ProposalKind;
  entityType: string;
  entityId: string | null;
  summary: Record<string, unknown>;
  payload: Record<string, unknown>;
  reason: string;
}

/** Records a proposal from an MCP client and notifies the members who can approve it. */
export async function createProposal(rt: ToolRuntime, input: ProposalInput): Promise<{ id: string; expiresAt: Date }> {
  const ctx = rt.ctx;
  const now = ctx.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MCP_LIMITS.proposalTtlDays * 864e5);
  const reason = sanitizeFreeText(input.reason, 500) || null;
  // the same action on the same record already waiting: one card in the inbox, not two
  if (input.entityId) {
    const p = schema.mcpPendingActions;
    const [open] = await ctx.tx.select({ id: p.id, expiresAt: p.expiresAt }).from(p).where(and(eq(p.tenantId, ctx.tenantId), eq(p.kind, input.kind), eq(p.entityId, input.entityId), eq(p.status, "pending"), sql`${p.expiresAt} > ${now}`)).limit(1);
    if (open) return { id: open.id, expiresAt: open.expiresAt };
  }
  const [row] = await ctx.tx.insert(schema.mcpPendingActions).values({ tenantId: ctx.tenantId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, summary: input.summary, payload: input.payload, reason, status: "pending", requestedBy: rt.userId, tokenId: rt.mcp?.tokenId ?? null, clientName: rt.mcp?.clientName ?? null, expiresAt, createdAt: now, updatedAt: now }).returning({ id: schema.mcpPendingActions.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: rt.userId, actorType: rt.mcp ? "mcp" : "user", action: "mcp.proposal_created", entityType: "mcp_pending_action", entityId: row!.id, diff: { status: { from: null, to: "pending" } }, metadata: { kind: input.kind, target: input.entityId, mcpClient: rt.mcp?.clientName ?? null, mcpTokenId: rt.mcp?.tokenId ?? null } });
  const members = await ctx.tx.select({ userId: schema.tenantMemberships.userId, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true)));
  const approvers = members.filter((m) => isTenantRole(m.role) && canApproveProposal(m.role, input.kind)).map((m) => m.userId);
  const label = String(input.summary.orderName ?? input.summary.campaignName ?? input.summary.supplierName ?? "");
  await notifyUsers(ctx, { userIds: approvers, type: "mcp_proposal", title: `${rt.mcp?.clientName ?? "AI"} · ${input.kind}${label ? ` · ${label}` : ""}`, body: reason ?? "", link: `/t/${rt.slug}/approvals`, metadata: { proposalId: row!.id, kind: input.kind } });
  return { id: row!.id, expiresAt };
}

export interface ProposalRow {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  summary: Record<string, unknown>;
  payload: Record<string, unknown>;
  reason: string | null;
  status: string;
  clientName: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  result: unknown;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** Proposals for the approval inbox: `pending` (not expired), `decided`, or all; newest first. */
export async function listProposals(ctx: ServiceContext, opts: { view?: "pending" | "decided" | "all"; limit?: number } = {}): Promise<ProposalRow[]> {
  const now = ctx.now ?? new Date();
  const p = schema.mcpPendingActions;
  const conds = [eq(p.tenantId, ctx.tenantId)];
  if (opts.view === "pending") conds.push(eq(p.status, "pending"), sql`${p.expiresAt} > ${now}`);
  else if (opts.view === "decided") conds.push(sql`(${p.status} <> 'pending' or ${p.expiresAt} <= ${now})`);
  const rows = await ctx.tx.select().from(p).where(and(...conds)).orderBy(desc(p.createdAt)).limit(opts.limit ?? 100);
  const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => Boolean(x)))];
  const users = ids.length ? await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), inArray(schema.users.id, ids))) : [];
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? users.find((u) => u.id === id)?.email ?? null) : null);
  return rows.map((r) => ({ id: r.id, kind: r.kind, entityType: r.entityType, entityId: r.entityId, summary: r.summary as Record<string, unknown>, payload: r.payload as Record<string, unknown>, reason: r.reason, status: r.status === "pending" && r.expiresAt <= now ? "expired" : r.status, clientName: r.clientName, requestedBy: r.requestedBy, requestedByName: name(r.requestedBy), decidedBy: r.decidedBy, decidedByName: name(r.decidedBy), decidedAt: r.decidedAt, decisionNote: r.decisionNote, result: r.result, error: r.error, expiresAt: r.expiresAt, createdAt: r.createdAt }));
}

export async function pendingProposalCount(ctx: ServiceContext): Promise<number> {
  const now = ctx.now ?? new Date();
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.mcpPendingActions).where(and(eq(schema.mcpPendingActions.tenantId, ctx.tenantId), eq(schema.mcpPendingActions.status, "pending"), sql`${schema.mcpPendingActions.expiresAt} > ${now}`));
  return r?.n ?? 0;
}

export class ProposalError extends Error {
  constructor(readonly code: "not_found" | "not_pending" | "expired" | "forbidden") {
    super(code);
    this.name = "ProposalError";
  }
}

export interface DecideInput {
  id: string;
  decision: "approve" | "reject";
  note?: string | null;
  role: TenantRole;
  /** The store's commerce platform, for cancellations and refunds (platform first). */
  commerce: () => Promise<CommercePlatform | undefined>;
}

export interface DecideResult {
  status: "approved" | "rejected" | "failed";
  error?: string;
  result?: Record<string, unknown>;
  /** Outbox writes the caller dispatches after the commit (campaign pause). */
  writes: PlatformWriteRow[];
}

/**
 * Approves (runs it) or rejects a proposal, as the deciding person. The action runs in a savepoint:
 * if it fails, nothing of it is kept and the proposal is marked failed with the error.
 */
export async function decideProposal(ctx: ServiceContext, input: DecideInput): Promise<DecideResult> {
  const now = ctx.now ?? new Date();
  const p = schema.mcpPendingActions;
  const [row] = await ctx.tx.select().from(p).where(and(eq(p.tenantId, ctx.tenantId), eq(p.id, input.id))).for("update").limit(1);
  if (!row) throw new ProposalError("not_found");
  if (!canApproveProposal(input.role, row.kind)) throw new ProposalError("forbidden");
  if (row.status !== "pending") throw new ProposalError("not_pending");
  const note = sanitizeFreeText(input.note ?? "", 500) || null;
  const audit = (action: string, to: string, metadata: Record<string, unknown> = {}) => recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action, entityType: "mcp_pending_action", entityId: row.id, diff: { status: { from: "pending", to } }, metadata: { kind: row.kind, target: row.entityId, mcpClient: row.clientName, requestedBy: row.requestedBy, note, ...metadata } });
  if (row.expiresAt <= now) {
    await ctx.tx.update(p).set({ status: "expired", updatedAt: now }).where(eq(p.id, row.id));
    await audit("mcp.proposal_expired", "expired");
    throw new ProposalError("expired");
  }
  if (input.decision === "reject") {
    await ctx.tx.update(p).set({ status: "rejected", decidedBy: ctx.actor.userId, decidedAt: now, decisionNote: note, updatedAt: now }).where(eq(p.id, row.id));
    await audit("mcp.proposal_rejected", "rejected");
    return { status: "rejected", writes: [] };
  }
  const payload = row.payload as Record<string, unknown>;
  const meta = { proposalId: row.id, mcpClient: row.clientName };
  const writes: PlatformWriteRow[] = [];
  let result: Record<string, unknown> = {};
  try {
    await ctx.tx.transaction(async (sp) => {
      const s: ServiceContext = { ...ctx, tx: sp };
      if (row.kind === "order.cancel") {
        const out = await cancelOrderWithPlatform(s, await input.commerce(), String(payload.orderId), { reason: String(payload.reason ?? "MCP proposal"), restock: payload.restock !== false, refund: payload.refund === true, source: "mcp_proposal", eventMetadata: meta });
        if (out.kind !== "cancelled") throw new Error(out.kind === "not_found" ? "Order not found" : "The order is already cancelled");
        result = { orderId: payload.orderId, status: out.result?.next ?? "cancelled" };
      } else if (row.kind === "order.refund") {
        const out = await refundOrder(s, await input.commerce(), { orderId: String(payload.orderId), amountMinor: Number(payload.amountMinor), note: typeof payload.note === "string" ? payload.note : null, requestId: row.id, notify: false });
        result = { orderId: out.orderId, refundedMinor: out.amountMinor, paymentStatus: out.paymentStatus };
      } else if (row.kind === "campaign.pause") {
        const [c] = await sp.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.id, String(payload.campaignId)))).limit(1);
        if (!c) throw new Error("Campaign not found");
        if (c.platform !== "meta") throw new Error("Only Meta campaigns can be paused from Hullwise");
        if (c.status === "paused") throw new Error("The campaign is already paused");
        await sp.update(schema.campaigns).set({ status: "paused" }).where(eq(schema.campaigns.id, c.id));
        await recordAudit(sp, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "campaign.paused", entityType: "campaign", entityId: c.id, diff: { status: { from: c.status, to: "paused" } }, metadata: meta });
        writes.push(await enqueuePlatformWrite(s, { kind: "campaign.status", entityType: "campaign", entityId: c.id, payload: { provider: "meta", campaignExternalId: c.externalId, status: "paused", ...(c.accountExternalId ? { accountExternalId: c.accountExternalId } : {}) } }));
        result = { campaignId: c.id, status: "paused" };
      } else if (row.kind === "purchase_order.create") {
        const lines = (Array.isArray(payload.lines) ? payload.lines : []) as PoLineInput[];
        const poId = await createPurchaseOrder(s, { supplierId: String(payload.supplierId), destinationLocationId: (payload.destinationLocationId as string | null) ?? null, currency: String(payload.currency), expectedAt: typeof payload.expectedAt === "string" ? new Date(payload.expectedAt) : null, notes: typeof payload.notes === "string" ? payload.notes : null, lines });
        await recordAudit(sp, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "purchase_order.created", entityType: "purchase_order", entityId: poId, diff: { status: { from: null, to: "draft" } }, metadata: meta });
        result = { purchaseOrderId: poId, status: "draft" };
      } else throw new Error(`Unknown proposal kind ${row.kind}`);
    });
  } catch (err) {
    writes.length = 0;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await ctx.tx.update(p).set({ status: "failed", decidedBy: ctx.actor.userId, decidedAt: now, decisionNote: note, error: message, updatedAt: now }).where(eq(p.id, row.id));
    await audit("mcp.proposal_failed", "failed", { error: message });
    return { status: "failed", error: message, writes };
  }
  await ctx.tx.update(p).set({ status: "approved", decidedBy: ctx.actor.userId, decidedAt: now, decisionNote: note, result, updatedAt: now }).where(eq(p.id, row.id));
  await audit("mcp.proposal_approved", "approved", { result });
  return { status: "approved", result, writes };
}
