import { z } from "zod";
import { MCP_LIMITS } from "@hullwise/config";
import { hullwiseLink, localDateTime, majorUnits, type HullwiseTool } from "@hullwise/services";
import { QUEUE_VIEWS, queueItems } from "./services";

/**
 * MCP tools of the COD add-on (#21). They carry `module: "addon.cod"`: the MCP server neither lists
 * nor runs them for a tenant without the add-on. The web app adds them to the core tool list.
 */

const queueInput = z.object({ view: z.enum(QUEUE_VIEWS).default("all").describe("Queue view; mine = assigned to the connected user, planned = confirmation scheduled for a later day, escalated = flagged for an admin"), limit: z.number().int().min(1).max(MCP_LIMITS.maxPageSize).default(20) });
const getCodQueue: HullwiseTool<typeof queueInput> = {
  name: "get_cod_queue",
  title: "Cash-on-delivery confirmation queue",
  page: "cod_queue",
  module: "addon.cod",
  scope: "read",
  effect: "read",
  description: "The cash-on-delivery confirmation queue in calling order: counts per view (to call, mine, unassigned, scheduled call-backs, planned confirmations, unreachable, escalated) and the next orders with delivery score (0-100), risk tier, attempts, call-back time and assignee. Example: { \"view\": \"unassigned\" }.",
  input: queueInput,
  async run(rt, input) {
    const q = await queueItems(rt.ctx, { view: input.view, userId: rt.userId, limit: 300 });
    const tz = rt.tenant.timezone;
    return {
      data: {
        timezone: tz,
        counts: q.counts,
        items: q.rows.slice(0, input.limit).map((r) => ({ order: r.order.name, customerName: r.order.customerName, phone: r.order.phone, city: r.order.shippingCity, total: majorUnits(r.order.totalMinor, r.order.currency), currency: r.order.currency, placedAt: localDateTime(r.order.placedAt, tz), queueStatus: r.item.status, deliveryScore: r.item.score, riskTier: r.item.riskTier, attempts: r.item.attemptsCount, callBackAt: localDateTime(r.item.callBackAt, tz), assigned: Boolean(r.item.assignedTo), link: hullwiseLink(rt, `/orders/${r.order.id}`) })),
        link: hullwiseLink(rt, "/cod"),
      },
    };
  },
};

export const COD_MCP_TOOLS: readonly HullwiseTool[] = [getCodQueue] as unknown as HullwiseTool[];
