/**
 * Recorded shapes of Spoki API answers and webhook deliveries (API v1), trimmed to the fields the adapter
 * reads. Phone numbers, ids and texts are invented; no customer data.
 */
export const SEND_OK = { id: 88123401, uuid: "5f1c2a9e-3b7d-4c11-9e0a-2b6d1f7c8a01", status: "Pending" };
export const SEND_NO_ID = { detail: "Message queued" };
export const SEND_CREDIT = { error: "Not enough credit", error_code: "spoki::1029" };

export const TEMPLATES_PAGE_1 = {
  count: 3,
  next: "https://api.spoki.com/api/1/templates/?page=2&page_size=100",
  results: [
    { id: 7001, name: "order_shipped", category: "UTILITY", status: 2, templatelocalization_set: [{ language: "en", body: "Hi %%FIRST_NAME%%, order %%ORDER_NAME%% has shipped: %%TRACKING_URL%%", status: 2 }], customfield_set: [{ key: "FIRST_NAME" }, { key: "ORDER_NAME" }] },
    { id: 7002, name: "cod_confirm", category: "UTILITY", status: 4, templatelocalization_set: [{ language: "it", body: "Ciao %%FIRST_NAME%%, confermi l'ordine %%ORDER_NAME%%?" }], customfield_set: ["FIRST_NAME", "ORDER_NAME"] },
  ],
};
export const TEMPLATES_PAGE_2 = { count: 3, next: null, results: [{ id: 7003, name: "promo_draft", category: "MARKETING", status: 3, templatelocalization_set: [{ language: "en", body: "Sale!" }], customfield_set: [] }, { name: "no id, skipped" }] };

export const CONTACTS_EMPTY = { count: 0, next: null, results: [] };
export const CONTACTS_ONE = { count: 1, next: null, results: [{ id: 4455, phone: "+393331234567", chat_link: "https://app.spoki.it/chats/abc", is_subscribed: true }] };

/** First "Sent" of a template: no template id yet, phone without the plus. */
export const WEBHOOK_SENT = { event: "message.outbound", data: { uuid: "5f1c2a9e-3b7d-4c11-9e0a-2b6d1f7c8a01", direction: "outbound", to_phone: "393331234567", send_status: "Sent", created_at: "2026-10-02T09:00:05Z", contact: { id: 4455 } } };
export const WEBHOOK_DELIVERED = { type: "message.outbound", message: { uuid: "5f1c2a9e-3b7d-4c11-9e0a-2b6d1f7c8a01", send_status: "Delivered", template: 7001, chat_id: "393331234567@c.us", created_at: "2026-10-02T09:00:09Z" } };
export const WEBHOOK_READ = { event: "message.outbound", payload: { id: "5f1c2a9e-3b7d-4c11-9e0a-2b6d1f7c8a01", send_status: "Read", contact: { id: 4455, phone: "+39 333 123 4567" } } };
export const WEBHOOK_ERROR = { event: "message.outbound", data: { uuid: "77aa", send_status: "Error", error_code: "whatsapp::131050", wa_id: "393339876543" } };
export const WEBHOOK_PENDING = { event: "message.outbound", data: { uuid: "77ab", send_status: "Pending" } };
/** A quick-reply button pressed on one of the store's messages. */
export const WEBHOOK_INBOUND_BUTTON = { event: "message.inbound", data: { uuid: "in-001", direction: "inbound", from_phone: "393331234567", text: "Yes, confirm", replyToMessageUid: "5f1c2a9e-3b7d-4c11-9e0a-2b6d1f7c8a01", created_at: "2026-10-02T09:03:00Z", contact: { id: 4455 } } };
export const WEBHOOK_INBOUND_MEDIA = { event: "message.inbound", result: { id: "in-002", chat_id: "447700900123@c.us", body: "", mediamessage_set: [{ id: 1, content_type: "Image" }] } };
export const WEBHOOK_INBOUND_STOP = { event: "message.inbound", data: { uuid: "in-003", from_phone: "393339876543", text: "STOP" } };
