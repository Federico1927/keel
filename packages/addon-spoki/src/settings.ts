import { z } from "zod";
import { ORDER_MESSAGE_EVENTS, type OrderMessageEvent } from "@hullwise/core";

/** The add-on's module key: every page, action, route, job and MCP tool checks it. */
export const SPOKI_MODULE = "addon.whatsapp_spoki";

/**
 * What a Spoki template can be mapped to: the three order notifications, the campaign message
 * (with `addon.customer_campaigns`) and each COD confirmation template (`cod:<key>`, with `addon.cod`).
 */
export const SPOKI_TEMPLATE_KEY = /^(order_confirmed|order_shipped|order_delivered|campaign|cod:[a-z0-9_-]{1,40})$/;
export type SpokiTemplateKey = OrderMessageEvent | "campaign" | `cod:${string}`;

/** Variables an order notification can fill (custom fields map to them). */
export const ORDER_NOTIFICATION_VARIABLES = ["first_name", "customer_name", "order_name", "total", "shop_name", "tracking_number", "tracking_url", "carrier"] as const;

const fieldName = z.string().trim().regex(/^[A-Za-z0-9_]{1,40}$/);
export const templateMappingSchema = z.object({
  /** Spoki template id (digits); null = send the rendered text as a free-form message (24-hour window only). */
  templateId: z.string().trim().regex(/^\d{1,12}$/).nullable().default(null),
  templateName: z.string().trim().max(120).nullable().default(null),
  /** Spoki custom field → template variable; empty = every variable under its upper-case name. */
  fields: z.record(fieldName, z.string().trim().max(40)).default({}),
});
export type TemplateMapping = z.infer<typeof templateMappingSchema>;

export const spokiSettingsSchema = z.object({
  /** The WhatsApp number messages leave from (E.164), as shown in the Spoki account. Informational: Spoki sends from the account's number. */
  senderNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/).nullable().default(null),
  /** Language of the approved templates (e.g. `it`, `en_US`); null = the tenant's language. */
  templateLanguage: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).nullable().default(null),
  templates: z.record(z.string().regex(SPOKI_TEMPLATE_KEY), templateMappingSchema).default({}),
  /** Order notifications per event: off by default, on once a template is mapped and the store wants them. */
  notify: z.object(Object.fromEntries(ORDER_MESSAGE_EVENTS.map((e) => [e, z.boolean().default(false)])) as Record<OrderMessageEvent, z.ZodDefault<z.ZodBoolean>>).prefault({}),
  /** A customer reply equal to one of these (or starting with it, when short) puts their number on the shared suppression list for marketing. */
  optOutKeywords: z.array(z.string().trim().min(1).max(40)).max(20).default(["STOP", "UNSUBSCRIBE"]),
  /** A reply is linked to the order of the last message sent to that number within this many days (campaign messages never link orders). */
  linkOrderDays: z.number().int().min(1).max(90).default(30),
});
export type SpokiSettings = z.infer<typeof spokiSettingsSchema>;

export function parseSpokiSettings(raw: unknown): SpokiSettings {
  const r = spokiSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : spokiSettingsSchema.parse({});
}

/** The mapping a send uses: `cod:<key>` for COD templates, `campaign` for campaign and test sends, the order event otherwise. */
export function templateFor(settings: SpokiSettings, purpose: string, template: string): TemplateMapping | null {
  const key = purpose === "cod" ? `cod:${template}` : purpose === "test" ? "campaign" : purpose;
  return settings.templates[key] ?? null;
}
