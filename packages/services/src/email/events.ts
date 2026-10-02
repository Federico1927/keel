import { and, eq, inArray, lt, schema, type DbExecutor } from "@keel/db";
import { emailAddressHash, type EmailDeliveryEvent } from "@keel/integrations";
import { suppressAddress } from "./suppressions";

/**
 * Provider delivery events (Resend webhooks), handled like the Shopify webhooks: the route stores
 * the verified event (unique on provider + event id, so a redelivery is a no-op), answers 200 at
 * once and the event is processed in the background. Only hashes of the recipients are stored.
 */
const KEPT_TAGS = ["template", "message_id", "tenant_id"];
const UUID = /^[0-9a-f-]{36}$/i;

export async function recordEmailEvent(db: DbExecutor, input: { provider: string; eventId: string; event: EmailDeliveryEvent; now?: Date }): Promise<{ id: string | null; duplicate: boolean; ignored: boolean }> {
  const e = input.event;
  const ignored = e.type === "other" || e.type === "sent";
  const tags = Object.fromEntries(Object.entries(e.tags).filter(([k]) => KEPT_TAGS.includes(k)));
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(schema.emailEvents)
    .values({ provider: input.provider, eventId: input.eventId.slice(0, 200), type: e.type, providerMessageId: e.providerMessageId, recipientHashes: e.recipients.map(emailAddressHash), bounce: e.bounce, tags, occurredAt: e.occurredAt, status: ignored ? "ignored" : "pending", receivedAt: now, processedAt: ignored ? now : null })
    .onConflictDoNothing()
    .returning({ id: schema.emailEvents.id });
  return { id: row?.id ?? null, duplicate: !row, ignored };
}

const ORDER: Record<string, number> = { queued: 0, sending: 0, sent: 1, delivery_delayed: 2, delivered: 3, failed: 4, bounced: 5, complained: 6 };

/** Applies one stored event: status on the log row, hard bounces and complaints to the platform suppression list. */
export async function processEmailEvent(db: DbExecutor, eventId: string, now = new Date()): Promise<"processed" | "ignored" | "failed" | "missing"> {
  const [ev] = await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.id, eventId)).limit(1);
  if (!ev) return "missing";
  if (ev.status === "processed" || ev.status === "ignored") return ev.status;
  const m = schema.emailMessages;
  try {
    const byProvider = ev.providerMessageId ? (await db.select().from(m).where(eq(m.providerMessageId, ev.providerMessageId)).limit(1))[0] : undefined;
    const tagId = ev.tags.message_id;
    const msg = byProvider ?? (tagId && UUID.test(tagId) ? (await db.select().from(m).where(eq(m.id, tagId)).limit(1))[0] : undefined);
    const at = ev.occurredAt ?? now;
    const advance = async (status: string, extra: Partial<typeof m.$inferInsert> = {}) => {
      if (!msg || (ORDER[status] ?? 0) < (ORDER[msg.status] ?? 0)) return;
      await db.update(m).set({ status, ...extra, updatedAt: now }).where(eq(m.id, msg.id));
    };
    if (ev.type === "delivered") await advance("delivered", { deliveredAt: at });
    else if (ev.type === "delivery_delayed") await advance("delivery_delayed");
    else if (ev.type === "failed") await advance("failed", { lastErrorCode: "provider_failed", lastError: "The provider could not deliver the email" });
    else if (ev.type === "bounced" && ev.bounce === "soft") {
      if (msg) await db.update(m).set({ lastErrorCode: "soft_bounce", lastError: "Temporary bounce reported by the provider", updatedAt: now }).where(eq(m.id, msg.id));
    } else if (ev.type === "bounced" || ev.type === "complained") {
      const reason = ev.type === "bounced" ? "bounce" : "complaint";
      await advance(ev.type, { lastErrorCode: ev.type === "bounced" ? "hard_bounce" : "complaint" });
      const hashes = ev.recipientHashes.length ? ev.recipientHashes : msg ? [msg.recipientHash] : [];
      for (const h of hashes) await suppressAddress(db, { emailHash: h, emailMasked: msg && msg.recipientHash === h ? msg.recipientMasked : "•••", reason, source: "provider", providerMessageId: ev.providerMessageId, now });
    }
    await db.update(schema.emailEvents).set({ status: "processed", attempts: ev.attempts + 1, processedAt: now, lastError: null }).where(eq(schema.emailEvents.id, ev.id));
    return "processed";
  } catch (e) {
    await db.update(schema.emailEvents).set({ status: "failed", attempts: ev.attempts + 1, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).where(eq(schema.emailEvents.id, ev.id));
    return "failed";
  }
}

/** Events left pending (process died after the 200) or failed: processed again, up to five attempts. */
export async function retryEmailEvents(db: DbExecutor, now = new Date()): Promise<number> {
  const rows = await db.select({ id: schema.emailEvents.id, attempts: schema.emailEvents.attempts }).from(schema.emailEvents).where(and(inArray(schema.emailEvents.status, ["pending", "failed"]), lt(schema.emailEvents.receivedAt, new Date(now.getTime() - 60_000)))).limit(500);
  let n = 0;
  for (const r of rows) if (r.attempts < 5 && (await processEmailEvent(db, r.id, now)) === "processed") n++;
  return n;
}
