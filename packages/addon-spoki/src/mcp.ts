import { z } from "zod";
import { MCP_LIMITS } from "@hullwise/config";
import { hullwiseLink, localDateTime, resolveOrderRef, type HullwiseTool } from "@hullwise/services";
import { listSpokiMessages } from "./services";
import { SPOKI_MODULE } from "./settings";

/**
 * MCP tools of the Spoki WhatsApp add-on (#9). `module: "addon.whatsapp_spoki"`: the MCP server
 * neither lists nor runs them for a tenant without the add-on. The web app adds them to the list.
 */
const messagesInput = z.object({ order: z.string().min(1).max(80).optional().describe("Order id, name (e.g. NW-1042) or number; omit for the latest messages of the store"), limit: z.number().int().min(1).max(MCP_LIMITS.maxPageSize).default(20) });
const getWhatsappMessages: HullwiseTool<typeof messagesInput> = {
  name: "get_whatsapp_messages",
  title: "WhatsApp message log",
  page: "orders",
  module: SPOKI_MODULE,
  scope: "read",
  effect: "read",
  description: "WhatsApp messages sent and received through Spoki: COD confirmations, order notifications, campaign messages and customer replies, with delivery status (sent, delivered, read, replied, failed). Example: { \"order\": \"NW-1042\" }.",
  input: messagesInput,
  async run(rt, input) {
    const order = input.order ? await resolveOrderRef(rt, input.order) : null;
    const rows = await listSpokiMessages(rt.ctx, { orderId: order?.id, limit: input.limit });
    const tz = rt.tenant.timezone;
    return {
      data: {
        timezone: tz,
        order: order ? { name: order.name, link: hullwiseLink(rt, `/orders/${order.id}`) } : null,
        messages: rows.map(({ m, orderName }) => ({ at: localDateTime(m.occurredAt, tz), direction: m.direction, purpose: m.purpose, status: m.status, template: m.templateName ?? m.templateId, text: m.body?.slice(0, 300) ?? null, phone: m.phone, order: orderName, errorCode: m.errorCode, link: m.orderId ? hullwiseLink(rt, `/orders/${m.orderId}`) : null })),
      },
    };
  },
};

export const SPOKI_MCP_TOOLS: readonly HullwiseTool[] = [getWhatsappMessages] as unknown as HullwiseTool[];
