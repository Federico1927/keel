import { z } from "zod";
import { and, eq, inArray, recordAudit, schema, sql } from "@keel/db";
import { MCP_LIMITS } from "@keel/config";
import { MCP_ORDER_TRANSITIONS, canMcpSetOrderStatus, sanitizeFreeText, type OrderStatus } from "@keel/core";
import { addOrderNote } from "../orders/notes";
import { setManualStatus } from "../orders/state";
import { assignOrderTo } from "../orders/writes";
import { normalizePoInput } from "../purchasing";
import { ToolError, keelLink, majorUnits, minorUnits, type KeelTool, type ToolRuntime } from "../tools";
import { createProposal } from "./pending";
import { resolveOrderRef } from "./read-tools";

/**
 * Write tools of the MCP server (#21). Safe by construction: the direct writes are reversible and
 * low-risk (an internal note, an assignee, a review or hold status); everything risky is a
 * proposal a person approves in Keel. Every write leaves an order event and an audit entry with
 * actor type `mcp`, the user, the client name and the field diff.
 */

/** A reference or exact name (SKU, email, supplier): one line, no control characters; matched with equality, never LIKE. */
const exact = (v: string, max = 200) => sanitizeFreeText(v, max).replace(/\s+/g, " ").trim();
const orderRef = z.string().min(1).max(80).describe("Order id, name (e.g. NW-1042) or number");
const reasonText = z.string().min(3).max(2000).describe("Why: shown to the person who approves, in your words (at most 500 characters are kept)");

function mcpMeta(rt: ToolRuntime): Record<string, unknown> {
  return rt.mcp ? { mcpClient: rt.mcp.clientName, mcpTokenId: rt.mcp.tokenId } : {};
}
function audit(rt: ToolRuntime, input: { action: string; entityType: string; entityId: string; diff: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  return recordAudit(rt.ctx.tx, { tenantId: rt.ctx.tenantId, actorUserId: rt.userId, actorType: rt.mcp ? "mcp" : "user", action: input.action, entityType: input.entityType, entityId: input.entityId, diff: input.diff, metadata: { ...(input.metadata ?? {}), ...mcpMeta(rt) } });
}

/* ---------- direct, reversible writes ---------- */

const noteInput = z.object({ order: orderRef, body: z.string().min(1).max(4000).describe(`The note (internal, never shown to the customer; at most ${MCP_LIMITS.textMaxChars} characters are kept)`) });
const addNote: KeelTool<typeof noteInput> = {
  name: "add_order_note",
  title: "Add an internal note to an order",
  page: "orders",
  action: "add_note",
  scope: "write:notes",
  effect: "write",
  description: "Adds an internal note to an order's timeline (visible to the team only, never to the customer). Example: { \"order\": \"NW-1042\", \"body\": \"Customer confirmed the new address by phone.\" }.",
  input: noteInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    const body = sanitizeFreeText(input.body);
    if (!body) throw new ToolError("invalid_input", "The note is empty.");
    const r = await addOrderNote(rt.ctx, { orderId: order.id, body, allowedMentionIds: [], link: `/t/${rt.slug}/orders/${order.id}`, orderName: order.name, authorName: rt.mcp?.clientName ?? "AI", eventMetadata: mcpMeta(rt) });
    await audit(rt, { action: "order.note_added", entityType: "order", entityId: order.id, diff: { noteId: { from: null, to: r.noteId } }, metadata: { length: body.length } });
    return { data: { ok: true, order: order.name, noteId: r.noteId, link: keelLink(rt, `/orders/${order.id}`) } };
  },
};

const assignInput = z.object({ order: orderRef, assignee: z.string().min(1).max(200).nullable().describe("\"me\" for the connected user, a team member's email, or null to unassign") });
const assign: KeelTool<typeof assignInput> = {
  name: "assign_order",
  title: "Assign an order to a team member",
  page: "orders",
  action: "assign",
  scope: "write:orders",
  effect: "write",
  description: "Assigns an order to a team member (\"me\" = the connected user, or a member's email) or removes the assignee (null). Example: { \"order\": \"NW-1042\", \"assignee\": \"me\" }.",
  input: assignInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    let userId: string | null = null;
    if (input.assignee === "me") userId = rt.userId;
    else if (input.assignee) {
      const email = exact(input.assignee).toLowerCase();
      const [m] = await rt.ctx.tx.select({ id: schema.users.id }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, rt.ctx.tenantId), eq(schema.tenantMemberships.isActive, true), eq(schema.users.email, email))).limit(1);
      if (!m) throw new ToolError("not_found", "No active team member with that email in this store.");
      userId = m.id;
    }
    const r = await assignOrderTo(rt.ctx, order.id, userId, { eventMetadata: mcpMeta(rt) });
    if (r.kind === "not_found") throw new ToolError("not_found", "Order not found.");
    if (r.kind === "assigned") await audit(rt, { action: "order.assigned", entityType: "order", entityId: order.id, diff: { assignedTo: { from: r.previous, to: userId } } });
    return { data: { ok: true, order: order.name, changed: r.kind === "assigned", link: keelLink(rt, `/orders/${order.id}`) } };
  },
};

const TARGETS = [...new Set(Object.values(MCP_ORDER_TRANSITIONS).flat())] as [OrderStatus, ...OrderStatus[]];
const statusInput = z.object({ order: orderRef, status: z.enum(TARGETS).describe("Target status"), note: z.string().max(1000).optional().describe("Why (kept on the timeline)") });
const setStatus: KeelTool<typeof statusInput> = {
  name: "set_order_status",
  title: "Move an order through review or hold",
  page: "orders",
  action: "change_order_state",
  scope: "write:orders",
  effect: "write",
  description: `Sets a manual status on an open order, only along these reversible steps: ${Object.entries(MCP_ORDER_TRANSITIONS).map(([from, to]) => `${from} → ${to!.join("/")}`).join("; ")}. Cancelling is not a status change: use propose_order_cancellation. Example: { "order": "NW-1042", "status": "on_hold", "note": "Waiting for the customer to confirm the size" }.`,
  input: statusInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    if (!canMcpSetOrderStatus(order.status, input.status)) throw new ToolError("conflict", `An AI client cannot move ${order.name} from ${order.status} to ${input.status}. Allowed from ${order.status}: ${(MCP_ORDER_TRANSITIONS[order.status as OrderStatus] ?? []).join(", ") || "none"}.`);
    const note = sanitizeFreeText(input.note ?? "", 500) || undefined;
    const r = await setManualStatus(rt.ctx, order.id, input.status, note, { eventMetadata: mcpMeta(rt) });
    await audit(rt, { action: "order.status_changed", entityType: "order", entityId: order.id, diff: { status: { from: r.previous, to: r.next } }, metadata: { note: note ?? null } });
    return { data: { ok: true, order: order.name, previous: r.previous, status: r.next, note: r.next === input.status ? undefined : `The status engine kept ${r.next} (a platform fact takes precedence).`, link: keelLink(rt, `/orders/${order.id}`) } };
  },
};

/* ---------- proposals ---------- */

function proposalAnswer(rt: ToolRuntime, id: string, expiresAt: Date, what: string) {
  return { data: { ok: true, proposalId: id, status: "pending_approval", message: `${what} is waiting for a person to approve it in Keel; nothing has changed yet. It expires on ${expiresAt.toISOString().slice(0, 10)} if nobody decides.`, approvalLink: keelLink(rt, "/approvals") } };
}

const cancelInput = z.object({ order: orderRef, reason: reasonText, restock: z.boolean().default(true).describe("Put the items back in stock"), refund: z.boolean().default(false).describe("Refund the payment, if captured") });
const proposeCancel: KeelTool<typeof cancelInput> = {
  name: "propose_order_cancellation",
  title: "Propose cancelling an order",
  page: "orders",
  action: "cancel_order",
  scope: "write:orders",
  effect: "proposal",
  description: "Proposes cancelling an order. Nothing happens until a team member who may cancel orders approves it in Keel. Example: { \"order\": \"NW-1042\", \"reason\": \"The customer asked to cancel by email\", \"restock\": true, \"refund\": true }.",
  input: cancelInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    if (order.cancelledAt) throw new ToolError("conflict", `${order.name} is already cancelled.`);
    if (["shipped", "delivered", "returned", "refunded"].includes(order.status)) throw new ToolError("conflict", `${order.name} is ${order.status}: it can no longer be cancelled, start a return instead.`);
    const reason = sanitizeFreeText(input.reason, 500);
    const p = await createProposal(rt, { kind: "order.cancel", entityType: "order", entityId: order.id, summary: { orderName: order.name, totalMinor: order.totalMinor, currency: order.currency, status: order.status, restock: input.restock, refund: input.refund }, payload: { orderId: order.id, reason, restock: input.restock, refund: input.refund }, reason });
    return proposalAnswer(rt, p.id, p.expiresAt, `Cancelling ${order.name}`);
  },
};

const refundInput = z.object({ order: orderRef, amount: z.number().positive().describe("Amount to refund, in the order's currency (major units, e.g. 19.90)"), reason: reasonText });
const proposeRefund: KeelTool<typeof refundInput> = {
  name: "propose_refund",
  title: "Propose a refund",
  page: "orders",
  action: "refund_order",
  scope: "write:orders",
  effect: "proposal",
  description: "Proposes refunding money on a paid order (never more than what is still refundable). Nothing happens until a team member who may refund approves it in Keel. Example: { \"order\": \"NW-1042\", \"amount\": 15, \"reason\": \"Late delivery goodwill\" }.",
  input: refundInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) throw new ToolError("conflict", `${order.name} has payment status ${order.paymentStatus}: only paid orders can be refunded.`);
    const amountMinor = minorUnits(input.amount, order.currency);
    const refundable = order.totalMinor - order.refundedMinor;
    if (amountMinor > refundable) throw new ToolError("invalid_input", `At most ${majorUnits(refundable, order.currency)} ${order.currency} can still be refunded on ${order.name}.`);
    const reason = sanitizeFreeText(input.reason, 500);
    const p = await createProposal(rt, { kind: "order.refund", entityType: "order", entityId: order.id, summary: { orderName: order.name, amountMinor, currency: order.currency, refundableMinor: refundable }, payload: { orderId: order.id, amountMinor, note: reason }, reason });
    return proposalAnswer(rt, p.id, p.expiresAt, `Refunding ${majorUnits(amountMinor, order.currency)} ${order.currency} on ${order.name}`);
  },
};

const pauseInput = z.object({ campaign: z.string().min(1).max(200).describe("Campaign id or exact name"), reason: reasonText });
const proposePause: KeelTool<typeof pauseInput> = {
  name: "propose_campaign_pause",
  title: "Propose pausing an ad campaign",
  page: "campaigns",
  action: "pause_campaign",
  scope: "write:campaigns",
  effect: "proposal",
  description: "Proposes pausing an active Meta campaign (Google is read-only in Keel). Nothing happens until a team member who may pause campaigns approves it in Keel. Use get_campaigns first to see the suggested action. Example: { \"campaign\": \"Summer linen – prospecting\", \"reason\": \"Losing money for 14 days and the product is low on stock\" }.",
  input: pauseInput,
  async run(rt, input) {
    const ref = exact(input.campaign);
    const c = schema.campaigns;
    const isId = z.string().uuid().safeParse(ref).success;
    const [campaign] = await rt.ctx.tx.select().from(c).where(and(eq(c.tenantId, rt.ctx.tenantId), isId ? eq(c.id, ref) : eq(sql`lower(${c.name})`, ref.toLowerCase()))).limit(1);
    if (!campaign) throw new ToolError("not_found", `No campaign "${ref}".`);
    if (campaign.platform !== "meta") throw new ToolError("conflict", "Only Meta campaigns can be paused from Keel; Google is read-only.");
    if (campaign.status !== "active") throw new ToolError("conflict", `The campaign is ${campaign.status}.`);
    const reason = sanitizeFreeText(input.reason, 500);
    const p = await createProposal(rt, { kind: "campaign.pause", entityType: "campaign", entityId: campaign.id, summary: { campaignName: campaign.name, platform: campaign.platform }, payload: { campaignId: campaign.id }, reason });
    return proposalAnswer(rt, p.id, p.expiresAt, `Pausing "${campaign.name}"`);
  },
};

const poInput = z.object({
  supplier: z.string().min(1).max(200).describe("Supplier id or exact name"),
  lines: z.array(z.object({ sku: z.string().min(1).max(80).describe("Variant SKU"), quantity: z.number().int().min(1).max(100_000), unitCost: z.number().min(0).optional().describe("Unit cost in the store currency; default: the supplier's or the variant's last cost") })).min(1).max(50),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Expected arrival, YYYY-MM-DD"),
  reason: reasonText,
});
const proposePo: KeelTool<typeof poInput> = {
  name: "propose_purchase_order",
  title: "Propose a draft purchase order",
  page: "purchasing",
  scope: "write:purchasing",
  effect: "proposal",
  description: "Proposes a draft purchase order to a supplier (lines by SKU and quantity, e.g. from get_stock_risk). Once a team member with purchasing access approves it, Keel creates the draft; sending it to the supplier stays a separate human step. Example: { \"supplier\": \"Lanificio Rossi\", \"lines\": [{ \"sku\": \"LS-001-M\", \"quantity\": 40 }], \"reason\": \"Stock-out in 6 days\" }.",
  input: poInput,
  async run(rt, input) {
    const s = schema.suppliers;
    const ref = exact(input.supplier);
    const isId = z.string().uuid().safeParse(ref).success;
    const [supplier] = await rt.ctx.tx.select().from(s).where(and(eq(s.tenantId, rt.ctx.tenantId), isId ? eq(s.id, ref) : eq(sql`lower(${s.name})`, ref.toLowerCase()))).limit(1);
    if (!supplier) throw new ToolError("not_found", `No supplier "${ref}".`);
    const skus = [...new Set(input.lines.map((l) => exact(l.sku, 80)))];
    const variants = await rt.ctx.tx.select({ id: schema.productVariants.id, sku: schema.productVariants.sku, costMinor: schema.productVariants.costMinor, title: schema.productVariants.title, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, rt.ctx.tenantId), inArray(schema.productVariants.sku, skus)));
    const missing = skus.filter((k) => !variants.some((v) => v.sku === k));
    if (missing.length) throw new ToolError("not_found", `Unknown SKU: ${missing.slice(0, 5).join(", ")}.`);
    const supplierCosts = await rt.ctx.tx.select({ variantId: schema.supplierVariants.variantId, cost: schema.supplierVariants.unitCostMinor }).from(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, rt.ctx.tenantId), eq(schema.supplierVariants.supplierId, supplier.id), inArray(schema.supplierVariants.variantId, variants.map((v) => v.id))));
    const currency = rt.tenant.currency;
    const lines = input.lines.map((l) => {
      const v = variants.find((x) => x.sku === exact(l.sku, 80))!;
      const cost = l.unitCost !== undefined ? minorUnits(l.unitCost, currency) : (supplierCosts.find((c) => c.variantId === v.id)?.cost ?? v.costMinor ?? 0);
      return { variantId: v.id, description: null, quantity: l.quantity, unitCostMinor: cost, label: `${v.product} · ${v.title}`, sku: v.sku };
    });
    // the same validation the purchase order form runs, before anyone is asked to approve
    await normalizePoInput(rt.ctx, { supplierId: supplier.id, destinationLocationId: null, lines });
    const totalMinor = lines.reduce((a, l) => a + l.quantity * l.unitCostMinor, 0);
    const reason = sanitizeFreeText(input.reason, 500);
    const p = await createProposal(rt, { kind: "purchase_order.create", entityType: "supplier", entityId: supplier.id, summary: { supplierName: supplier.name, lines: lines.map((l) => ({ sku: l.sku, label: l.label, quantity: l.quantity, unitCostMinor: l.unitCostMinor })), totalMinor, currency }, payload: { supplierId: supplier.id, destinationLocationId: null, currency, expectedAt: input.expectedDate ?? null, notes: reason, lines: lines.map((l) => ({ variantId: l.variantId, description: null, quantity: l.quantity, unitCostMinor: l.unitCostMinor })) }, reason });
    return proposalAnswer(rt, p.id, p.expiresAt, `A draft purchase order to ${supplier.name} (${lines.length} lines, ${majorUnits(totalMinor, currency)} ${currency})`);
  },
};

export const MCP_WRITE_TOOLS: readonly KeelTool[] = [addNote, assign, setStatus, proposeCancel, proposeRefund, proposePause, proposePo] as unknown as KeelTool[];
