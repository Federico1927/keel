import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { MOCK_SPOKI_TEMPLATES, createRng } from "@hullwise/integrations";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Spoki settings of the demo tenant with the add-on: templates mapped per event, shipping and delivery notifications on. */
export const DEMO_SPOKI_SETTINGS = {
  senderNumber: "+390200000000",
  templateLanguage: "it",
  templates: {
    "cod:conferma": { templateId: "40101", templateName: "cod_confirmation", fields: {} },
    order_confirmed: { templateId: "40102", templateName: "order_confirmed", fields: {} },
    order_shipped: { templateId: "40103", templateName: "order_shipped", fields: {} },
    order_delivered: { templateId: "40104", templateName: "order_delivered", fields: {} },
    campaign: { templateId: "40105", templateName: "winback_offer", fields: {} },
  },
  notify: { order_confirmed: false, order_shipped: true, order_delivered: true },
  optOutKeywords: ["STOP", "DISISCRIVIMI", "NON SCRIVERMI"],
  linkOrderDays: 30,
};

export function demoSpokiIntegration(tenantId: string, now: Date) {
  return { tenantId, provider: "spoki", status: "connected", mode: "mock", externalAccountId: "spoki-demo", externalAccountName: "Simulated Spoki account", credentialsEncrypted: null, config: {}, lastSyncAt: new Date(now.getTime() - 3600e3), lastSuccessAt: new Date(now.getTime() - 3600e3) };
}

const STATUS_MIX = [["read", 45], ["delivered", 35], ["sent", 8], ["failed", 4], ["replied", 8]] as const;

/**
 * Demo rows for `addon.whatsapp_spoki` (issue #9) on the tenant that has it: the simulated account
 * connected, settings with templates mapped, and a plausible message log of the last 30 days: COD
 * confirmations mirroring the COD message rows (one customer asking a question), shipping and
 * delivery notifications with timeline events, the WhatsApp win-back sequence's messages, one
 * opt-out ("STOP") on the shared suppression list, and the webhook events that carried receipts.
 */
export async function seedSpoki(db: Db, tenantId: string, now: Date): Promise<void> {
  const rng = createRng(20261009);
  const day = 864e5;
  await db.insert(schema.integrations).values(demoSpokiIntegration(tenantId, now)).onConflictDoNothing();
  await db.insert(schema.spokiSettings).values({ tenantId, config: DEMO_SPOKI_SETTINGS, templates: MOCK_SPOKI_TEMPLATES, templatesSyncedAt: new Date(now.getTime() - 3600e3), notifiedUntil: now }).onConflictDoNothing();
  const rows: (typeof schema.spokiMessages.$inferInsert)[] = [];
  const events: (typeof schema.orderEvents.$inferInsert)[] = [];
  const statusAt = (sentAt: Date, status: string) => new Date(sentAt.getTime() + (status === "sent" ? 2 : status === "delivered" ? 20 : 300) * 1000 + (status === "replied" ? 1800e3 : 0));

  // COD confirmations: the same provider ids as the COD message rows
  const cod = await db.execute<{ order_id: string; provider_message_id: string; status: string; created_at: Date; phone: string | null; customer_id: string | null; sent_by: string | null }>(sql`
    select m.order_id, m.provider_message_id, m.status, m.created_at, o.phone_e164 as phone, o.customer_id, m.sent_by
    from cod_messages m join orders o on o.id = m.order_id where m.tenant_id = ${tenantId} and m.provider_message_id is not null order by m.created_at`);
  for (const [i, m] of cod.rows.entries()) {
    if (!m.phone) continue;
    const sentAt = new Date(m.created_at);
    const status = i === 0 ? "replied" : m.status;
    rows.push({ tenantId, direction: "outbound", purpose: "cod", providerMessageId: m.provider_message_id, phone: m.phone, customerId: m.customer_id, orderId: m.order_id, templateId: "40101", templateName: "cod_confirmation", body: "Ciao, confermi l'ordine in contrassegno? Rispondi SÌ per confermare.", status, statusAt: statusAt(sentAt, status), sentBy: m.sent_by, occurredAt: sentAt, createdAt: sentAt });
    if (i === 0) {
      const at = new Date(sentAt.getTime() + 25 * 60e3);
      rows.push({ tenantId, direction: "inbound", purpose: "reply", providerMessageId: `seed-spk-in-cod-${i}`, phone: m.phone, customerId: m.customer_id, orderId: m.order_id, body: "A che ora passa il corriere? Domani sono al lavoro fino alle 18.", status: "received", statusAt: at, replyToMessageId: m.provider_message_id, occurredAt: at, createdAt: at });
      events.push({ tenantId, orderId: m.order_id, type: "whatsapp_reply", actorType: "integration", actorUserId: null, diff: {}, metadata: { text: "A che ora passa il corriere? Domani sono al lavoro fino alle 18.", messageId: `seed-spk-in-cod-${i}`, optOut: false }, createdAt: at });
    }
  }

  // shipping and delivery notifications of the last 30 days
  const shipped = await db.execute<{ id: string; name: string; phone: string; customer_id: string | null; status: string; shipped_at: Date; delivered_at: Date | null; tracking_url: string | null }>(sql`
    select * from (
      select o.id, o.name, s.tracking_url, o.phone_e164 as phone, o.customer_id, o.status, s.shipped_at, s.delivered_at, row_number() over (partition by o.status order by s.shipped_at desc, o.id) as rn
      from orders o join lateral (select coalesce(x.shipped_at, x.created_at) as shipped_at, x.delivered_at, x.tracking_url from shipments x where x.order_id = o.id order by x.created_at limit 1) s on true
      where o.tenant_id = ${tenantId} and o.phone_e164 is not null and o.status in ('shipped', 'delivered') and s.shipped_at > ${new Date(now.getTime() - 30 * day)} and s.shipped_at < ${now}
    ) x where rn <= 35 order by shipped_at desc`);
  for (const [i, o] of shipped.rows.entries()) {
    const sentAt = new Date(new Date(o.shipped_at).getTime() + 15 * 60e3);
    if (sentAt > now) continue;
    const status = i === 1 ? "failed" : rng.weighted(STATUS_MIX.map(([s, w]) => [s === "replied" ? "read" : s, w] as const));
    const id = `seed-spk-ship-${i}`;
    rows.push({ tenantId, direction: "outbound", purpose: "order_shipped", providerMessageId: id, idempotencyKey: `order:${o.id}:order_shipped`, phone: o.phone, customerId: o.customer_id, orderId: o.id, templateId: "40103", templateName: "order_shipped", body: `L'ordine ${o.name} è stato spedito${o.tracking_url ? `: ${o.tracking_url}` : "."}`, status, statusAt: statusAt(sentAt, status), errorCode: status === "failed" ? "whatsapp::131026" : null, errorMessage: status === "failed" ? "Recipient is not a WhatsApp user" : null, occurredAt: sentAt, createdAt: sentAt });
    events.push({ tenantId, orderId: o.id, type: "whatsapp_message", actorType: "system", actorUserId: null, diff: {}, metadata: { purpose: "order_shipped", template: "order_shipped", messageId: id, provider: "spoki" }, createdAt: sentAt });
    if (o.status === "delivered" && o.delivered_at && new Date(o.delivered_at) < now && status !== "failed") {
      const at = new Date(new Date(o.delivered_at).getTime() + 10 * 60e3);
      if (at > now) continue;
      const st = rng.weighted([["read", 60], ["delivered", 40]] as const);
      rows.push({ tenantId, direction: "outbound", purpose: "order_delivered", providerMessageId: `seed-spk-dlv-${i}`, idempotencyKey: `order:${o.id}:order_delivered`, phone: o.phone, customerId: o.customer_id, orderId: o.id, templateId: "40104", templateName: "order_delivered", body: `L'ordine ${o.name} è stato consegnato. Buon divertimento!`, status: st, statusAt: statusAt(at, st), occurredAt: at, createdAt: at });
      events.push({ tenantId, orderId: o.id, type: "whatsapp_message", actorType: "system", actorUserId: null, diff: {}, metadata: { purpose: "order_delivered", template: "order_delivered", messageId: `seed-spk-dlv-${i}`, provider: "spoki" }, createdAt: at });
    }
  }

  // the WhatsApp win-back sequence (customer campaigns add-on): its sent exposures, one opt-out
  const exposures = await db.execute<{ customer_id: string; campaign_id: string; message_id: string; idempotency_key: string | null; sent_at: Date; phone: string; message: string; first_name: string | null; code: string | null }>(sql`
    select e.customer_id, e.campaign_id, e.message_id, e.idempotency_key, e.sent_at, c.phone_e164 as phone, rc.message, c.first_name, rc.discount_code as code
    from retention_exposures e join retention_campaigns rc on rc.id = e.campaign_id join customers c on c.id = e.customer_id
    where e.tenant_id = ${tenantId} and rc.channel = 'whatsapp' and e.status = 'sent' and e.message_id is not null and c.phone_e164 is not null
    order by e.sent_at desc limit 40`);
  for (const [i, e] of exposures.rows.entries()) {
    const sentAt = new Date(e.sent_at);
    const status = i === 0 ? "replied" : rng.weighted(STATUS_MIX.filter(([st]) => st !== "replied"));
    rows.push({ tenantId, direction: "outbound", purpose: "campaign", providerMessageId: e.message_id, idempotencyKey: e.idempotency_key, phone: e.phone, customerId: e.customer_id, campaignId: e.campaign_id, templateId: "40105", templateName: "winback_offer", body: e.message.replaceAll("{first_name}", e.first_name ?? "").replaceAll("{code}", e.code ?? "").slice(0, 500), status, statusAt: statusAt(sentAt, status), occurredAt: sentAt, createdAt: sentAt });
    if (i === 0) {
      const at = new Date(Math.min(now.getTime(), sentAt.getTime() + 40 * 60e3));
      rows.push({ tenantId, direction: "inbound", purpose: "reply", providerMessageId: "seed-spk-in-stop", phone: e.phone, customerId: e.customer_id, campaignId: e.campaign_id, body: "STOP", status: "received", statusAt: at, replyToMessageId: e.message_id, occurredAt: at, createdAt: at });
      await db.insert(schema.emailSuppressions).values({ tenantId, email: e.phone, identityType: "phone", reason: "unsubscribe", category: "marketing", source: "spoki", note: "STOP", createdAt: at }).onConflictDoNothing();
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(schema.spokiMessages).values(rows.slice(i, i + 500)).onConflictDoNothing();
  for (let i = 0; i < events.length; i += 500) await db.insert(schema.orderEvents).values(events.slice(i, i + 500));
  // the receipts of the latest messages, as the webhook stored them
  const latest = rows.filter((r) => r.direction === "outbound" && r.status !== "sent").slice(-4);
  for (const r of latest) await db.insert(schema.webhookEvents).values({ tenantId, source: "spoki", topic: "message.status", externalId: r.providerMessageId!, sourceUpdatedAt: r.status === "replied" ? "read" : r.status, payload: { event: "message.outbound", data: { uuid: r.providerMessageId, send_status: r.status === "failed" ? "Error" : r.status === "replied" ? "Read" : r.status[0]!.toUpperCase() + r.status.slice(1) } }, status: "processed", attempts: 1, processedAt: r.statusAt, receivedAt: r.statusAt ?? now }).onConflictDoNothing();
  await db.insert(schema.integrationHealth).values({ tenantId, source: "spoki:webhooks", status: "ok", lastAttemptAt: new Date(now.getTime() - 3600e3), lastSuccessAt: new Date(now.getTime() - 3600e3), consecutiveFailures: 0, rowsWrittenLast: 1, freshnessMinutes: 7 * 24 * 60 }).onConflictDoNothing();
}
