import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Demo rows that make the two in-development messaging add-ons demonstrable on Northwind (the
 * WhatsApp channel with Spoki, #9, and customer campaigns, #34/#38): a measured one-off WhatsApp
 * campaign sent through Spoki, its message log with a few replies, customer threads with the team's
 * answers (one still awaiting a reply), and an approved campaign scheduled well ahead. Every
 * function is idempotent (guarded by a name or a marker row) and insert-only: the full seed calls
 * them, and `ensureDemoSettings` calls them on every deploy so a hosted demo gets them without a
 * reseed and a second run adds nothing.
 */

export const WHATSAPP_SHOWCASE_CAMPAIGN = "Saldi di fine estate su WhatsApp -20%";
export const SCHEDULED_SHOWCASE_CAMPAIGN = "Anteprima collezione inverno";
const CONVERSATION_MARKER = "seed-spk-conv-0";

export interface ShowcaseUsers {
  owner: string | null;
  marketing: string | null;
  care: string | null;
}

/** The demo users the showcase rows name as authors, by their demo email. */
export async function showcaseUsers(db: Db): Promise<ShowcaseUsers> {
  const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(sql`${schema.users.email} in ('owner@northwind.demo', 'marketing@northwind.demo', 'care@northwind.demo')`);
  const by = (e: string) => rows.find((r) => r.email === e)?.id ?? null;
  return { owner: by("owner@northwind.demo"), marketing: by("marketing@northwind.demo"), care: by("care@northwind.demo") };
}

const segmentId = async (db: Db, tenantId: string, name: string) => (await db.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, tenantId), eq(schema.segments.name, name))).limit(1))[0]?.id ?? null;
const campaignId = async (db: Db, tenantId: string, name: string) => (await db.select({ id: schema.retentionCampaigns.id }).from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, tenantId), eq(schema.retentionCampaigns.name, name))).limit(1))[0]?.id ?? null;

/**
 * Response orders of a sent demo campaign, so its results show a real, significant uplift: treated
 * customers who did not already buy in the window reorder their last delivered basket, enough of
 * them for the treated conversion to beat the control group's by `uplift` (set structurally, not by
 * chance: a reseed at another hour once left p = 0.09). Each response uses the campaign's code.
 */
export async function insertCampaignResponses(db: Db, input: { tenantId: string; campaignId: string; code: string; discountRate: number; uplift: number; windowDays: number }): Promise<void> {
  const { tenantId, campaignId: id, code, discountRate, uplift, windowDays } = input;
  const [tenant] = await db.select({ prefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  // copy every stored column (generated ones such as the search blob are recomputed)
  const cols = async (table: string) => (await db.execute<{ c: string }>(sql`select quote_ident(column_name) as c from information_schema.columns where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' order by ordinal_position`)).rows.map((r) => r.c).join(", ");
  const orderCols = sql.raw(await cols("orders"));
  const lineCols = sql.raw(await cols("order_lines"));
  const spread = Math.max(1, windowDays - 2);
  await db.execute(sql`
    with window_buyers as (
      select e.customer_id, e.group_name, exists (
        select 1 from orders o where o.customer_id = e.customer_id and o.placed_at > e.exposed_at and o.placed_at <= e.exposed_at + make_interval(days => ${windowDays}::int) and o.status not in ('cancelled', 'returned')
      ) as bought
      from retention_exposures e where e.campaign_id = ${id}
    ),
    needed as (
      -- at least a few responders even when chance already favours the treated group (small test seeds)
      select greatest(ceil(0.05 * count(*) filter (where group_name = 'treated')),
        ceil((coalesce(avg(bought::int) filter (where group_name = 'holdout'), 0) + ${uplift}::numeric) * count(*) filter (where group_name = 'treated'))
        - count(*) filter (where group_name = 'treated' and bought))::int as n
      from window_buyers
    ),
    responders as (
      select e.customer_id, e.exposed_at from retention_exposures e join window_buyers w on w.customer_id = e.customer_id
      where e.campaign_id = ${id} and e.group_name = 'treated' and not w.bought
        and exists (select 1 from orders o where o.customer_id = e.customer_id and o.placed_at < e.exposed_at and o.status in ('delivered', 'shipped'))
      order by abs(hashtext(e.customer_id::text || 'resp')), e.customer_id
      limit (select n from needed)
    ),
    picks as (
      select distinct on (r.customer_id) o.id as old_id, gen_random_uuid() as new_id,
        r.exposed_at + make_interval(days => 1 + abs(hashtext(r.customer_id::text || 'day')) % ${spread}::int, hours => abs(hashtext(r.customer_id::text)) % 10) as at
      from responders r join orders o on o.customer_id = r.customer_id and o.placed_at < r.exposed_at and o.status in ('delivered', 'shipped')
      order by r.customer_id, o.placed_at desc
    ),
    numbered as (select p.*, (select max(order_number) from orders where tenant_id = ${tenantId}) + row_number() over (order by p.at) as num from picks p),
    ins as (
      insert into orders (${orderCols}) select ${orderCols} from (select (jsonb_populate_record(null::orders, to_jsonb(o) || jsonb_build_object(
        'id', n.new_id, 'external_id', 'crm-' || n.new_id, 'order_number', n.num, 'name', '#' || ${tenant!.prefix} || n.num,
        'status', 'delivered', 'status_changed_at', n.at + interval '4 days', 'cancelled_at', null, 'cancel_reason', null, 'refunded_minor', 0, 'returned_fraction_bps', 0,
        'placed_at', n.at, 'closed_at', n.at + interval '4 days', 'platform_updated_at', n.at + interval '4 days', 'created_at', n.at, 'updated_at', n.at + interval '4 days'))).*
        from orders o join numbered n on n.old_id = o.id) r
      returning id, total_minor
    ),
    lines as (
      insert into order_lines (${lineCols}) select ${lineCols} from (select (jsonb_populate_record(null::order_lines, to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'order_id', n.new_id, 'external_id', 'crm-' || gen_random_uuid(), 'created_at', n.at))).*
        from order_lines l join numbered n on n.old_id = l.order_id) r
      returning id
    )
    insert into order_discounts (tenant_id, order_id, code, type, amount_minor)
    select ${tenantId}, ins.id, ${code}, 'percentage', round(ins.total_minor * ${discountRate}::numeric)::int from ins`);
}

/**
 * A one-off WhatsApp campaign (customer campaigns add-on) sent 20 days ago through Spoki to the
 * repeat customers' segment with its control group: treated customers with a phone got the
 * message, the others were skipped; about 6 points of uplift with a 10-day window, closed, so the
 * results are final. Created once (by name); its Spoki messages come from `ensureWhatsappShowcaseMessages`.
 */
export async function ensureWhatsappShowcaseCampaign(db: Db, tenantId: string, now: Date, users: ShowcaseUsers): Promise<boolean> {
  if (await campaignId(db, tenantId, WHATSAPP_SHOWCASE_CAMPAIGN)) return false;
  const segId = await segmentId(db, tenantId, "Clienti ricorrenti");
  if (!segId) return false;
  const day = 864e5;
  const sentAt = new Date(now.getTime() - 20 * day);
  const [c] = await db.insert(schema.retentionCampaigns).values({
    tenantId, name: WHATSAPP_SHOWCASE_CAMPAIGN, segmentId: segId, channel: "whatsapp", kind: "one_off", message: "Ciao {first_name}, i saldi di fine estate sono iniziati: per te il 20% in più con il codice {code}, fino a domenica.", discountCode: "ESTATE20", costPerMessageMinor: 5, attributionDays: 10, status: "sent",
    testSentAt: new Date(sentAt.getTime() - 2 * day), testSentBy: users.marketing, submittedAt: new Date(sentAt.getTime() - 2 * day), submittedBy: users.marketing, approvedAt: new Date(sentAt.getTime() - day), approvedBy: users.owner, scheduledAt: sentAt, scheduledBy: users.marketing,
    sentAt, sentBy: users.marketing, completedAt: new Date(sentAt.getTime() + 40 * 60e3), createdBy: users.marketing, createdAt: new Date(sentAt.getTime() - 3 * day), updatedAt: sentAt,
  }).returning({ id: schema.retentionCampaigns.id });
  const id = c!.id;
  // the groups the segment had at send time; the message id is what the Spoki log knows it by
  await db.execute(sql`
    insert into retention_exposures (tenant_id, campaign_id, customer_id, group_name, status, message_id, idempotency_key, attempts, exposed_at, sent_at)
    select ${tenantId}, ${id}, m.customer_id, m.group_name,
      case when m.group_name = 'holdout' then 'held_out' when cu.phone_e164 is null then 'skipped' else 'sent' end,
      case when m.group_name = 'treated' and cu.phone_e164 is not null then 'spk_seed_wa_' || left(md5(${id}::text || m.customer_id::text), 16) end,
      case when m.group_name = 'treated' and cu.phone_e164 is not null then 'rc:' || ${id}::text || ':' || m.customer_id::text || ':whatsapp' end,
      case when m.group_name = 'treated' and cu.phone_e164 is not null then 1 else 0 end,
      ${sentAt}::timestamptz + make_interval(secs => abs(hashtext(m.customer_id::text)) % 1800),
      case when m.group_name = 'treated' and cu.phone_e164 is not null then ${sentAt}::timestamptz + make_interval(secs => abs(hashtext(m.customer_id::text)) % 1800) end
    from segment_memberships m join customers cu on cu.id = m.customer_id
    where m.segment_id = ${segId} and cu.accepts_marketing
    on conflict do nothing`);
  await insertCampaignResponses(db, { tenantId, campaignId: id, code: "ESTATE20", discountRate: 0.2, uplift: 0.06, windowDays: 10 });
  const [n] = (await db.execute<{ t: number; h: number; d: number; s: number }>(sql`select count(*) filter (where group_name = 'treated')::int as t, count(*) filter (where group_name = 'holdout')::int as h, count(*) filter (where status = 'sent')::int as d, count(*) filter (where status = 'skipped')::int as s from retention_exposures where campaign_id = ${id}`)).rows;
  await db.update(schema.retentionCampaigns).set({ treatedCount: n!.t, holdoutCount: n!.h, deliveredCount: n!.d, skippedCount: n!.s }).where(eq(schema.retentionCampaigns.id, id));
  return true;
}

/** Customer replies to the WhatsApp campaign (one per thread, the first three recipients by message id). */
const CAMPAIGN_REPLIES = ["Il codice vale anche sui capi già in saldo?", "Grazie! Ho appena ordinato 😊", "Avete ancora la giacca in lino taglia M?"];

/**
 * The WhatsApp campaign's messages in the Spoki log (with `addon.whatsapp_spoki`): one row per
 * delivered message with a plausible receipt mix, a few recipients who answered. Once: skipped
 * when the log already holds a message of that campaign.
 */
export async function ensureWhatsappShowcaseMessages(db: Db, tenantId: string): Promise<boolean> {
  const id = await campaignId(db, tenantId, WHATSAPP_SHOWCASE_CAMPAIGN);
  if (!id) return false;
  const [has] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from spoki_messages where tenant_id = ${tenantId} and campaign_id = ${id}`)).rows;
  if ((has?.n ?? 0) > 0) return false;
  const [c] = await db.select().from(schema.retentionCampaigns).where(eq(schema.retentionCampaigns.id, id));
  // receipts by a stable hash of the message id: ~50% read, 30% delivered, 9% sent, 4% failed (not a WhatsApp user), first replies
  const inserted = await db.execute(sql`
    insert into spoki_messages (tenant_id, direction, purpose, provider_message_id, idempotency_key, phone, customer_id, campaign_id, template_id, template_name, body, status, status_at, error_code, error_message, sent_by, occurred_at, created_at, updated_at)
    select ${tenantId}, 'outbound', 'campaign', e.message_id, e.idempotency_key, cu.phone_e164, e.customer_id, ${id}, '40105', 'winback_offer',
      replace(replace(${c!.message}, '{first_name}', coalesce(cu.first_name, '')), '{code}', ${c!.discountCode ?? ""}),
      x.status, e.sent_at + case x.status when 'sent' then interval '2 seconds' when 'delivered' then interval '20 seconds' when 'failed' then interval '5 seconds' else interval '6 minutes' end,
      case when x.status = 'failed' then 'whatsapp::131026' end, case when x.status = 'failed' then 'Recipient is not a WhatsApp user' end,
      ${c!.sentBy}, e.sent_at, e.sent_at, e.sent_at
    from retention_exposures e join customers cu on cu.id = e.customer_id
    cross join lateral (select case when abs(hashtext(e.message_id)) % 100 < 50 then 'read' when abs(hashtext(e.message_id)) % 100 < 80 then 'delivered' when abs(hashtext(e.message_id)) % 100 < 89 then 'sent' when abs(hashtext(e.message_id)) % 100 < 93 then 'failed' else 'read' end as status) x
    where e.campaign_id = ${id} and e.status = 'sent' and e.message_id is not null and cu.phone_e164 is not null
    on conflict do nothing`);
  if (!inserted.rowCount) return false;
  const first = await db.execute<{ id: string; provider_message_id: string; phone: string; customer_id: string | null; status_at: Date }>(sql`select id, provider_message_id, phone, customer_id, status_at from spoki_messages where tenant_id = ${tenantId} and campaign_id = ${id} and status = 'read' order by provider_message_id limit ${CAMPAIGN_REPLIES.length}`);
  for (const [i, m] of first.rows.entries()) {
    const at = new Date(new Date(m.status_at).getTime() + (15 + i * 40) * 60e3);
    await db.insert(schema.spokiMessages).values({ tenantId, direction: "inbound", purpose: "reply", providerMessageId: `seed-spk-in-wa-${i}`, phone: m.phone, customerId: m.customer_id, campaignId: id, body: CAMPAIGN_REPLIES[i]!, status: "received", statusAt: at, replyToMessageId: m.provider_message_id, occurredAt: at, createdAt: at }).onConflictDoNothing();
    await db.update(schema.spokiMessages).set({ status: "replied", statusAt: at }).where(eq(schema.spokiMessages.id, m.id));
  }
  return true;
}

interface Turn {
  /** Minutes after the anchor (the notification the customer answers); negative = minutes before now. */
  at: number;
  from: "customer" | "team";
  text: string;
}

/** Threads started by customers answering their shipping notification: two answered by the team, one waiting. */
const THREADS: Turn[][] = [
  [
    { at: 120, from: "customer", text: "Ciao, il pacco è arrivato ma la taglia mi sta grande. Posso cambiarla?" },
    { at: 145, from: "team", text: "Certo! Apri il reso dal link nella mail di conferma e scegli \"cambio\": il corriere passa a ritirarlo gratis." },
    { at: 160, from: "customer", text: "Perfetto, grazie mille!" },
  ],
  [
    { at: 60 * 26, from: "customer", text: "Il tracking non si aggiorna da due giorni, è tutto ok?" },
    { at: 60 * 26 + 35, from: "team", text: "Abbiamo sollecitato il corriere: il pacco è al centro di smistamento di Bologna, arriva domani." },
  ],
  [{ at: -95, from: "customer", text: "Buongiorno, posso far consegnare il pacco in ufficio? Via Roma 10, Milano, dalle 9 alle 18." }],
];

/**
 * Customer conversations in the Spoki log: customers answering their latest shipping notifications,
 * the customer-care answers (free text within the 24-hour window, purpose `manual`), and one
 * question still waiting for an answer. Linked to the order (timeline events). Once (marker row).
 */
export async function ensureDemoConversations(db: Db, tenantId: string, now: Date, users: ShowcaseUsers): Promise<boolean> {
  const [marker] = await db.select({ id: schema.spokiMessages.id }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, tenantId), eq(schema.spokiMessages.providerMessageId, CONVERSATION_MARKER))).limit(1);
  if (marker) return false;
  // the latest shipping notifications at least two days old (every turn fits before now) that reached distinct customers, not answered yet
  const anchors = await db.execute<{ id: string; provider_message_id: string; phone: string; customer_id: string | null; order_id: string | null; occurred_at: Date }>(sql`
    select * from (
      select distinct on (m.phone) m.id, m.provider_message_id, m.phone, m.customer_id, m.order_id, m.occurred_at
      from spoki_messages m where m.tenant_id = ${tenantId} and m.direction = 'outbound' and m.purpose = 'order_shipped' and m.status in ('read', 'delivered') and m.provider_message_id is not null and m.occurred_at < ${new Date(now.getTime() - 2 * 864e5)}
        and not exists (select 1 from spoki_messages r where r.tenant_id = m.tenant_id and r.phone = m.phone and r.direction = 'inbound')
      order by m.phone, m.occurred_at desc
    ) x order by occurred_at desc limit ${THREADS.length}`);
  if (anchors.rows.length < THREADS.length) return false;
  let n = 0;
  for (const [i, a] of anchors.rows.entries()) {
    const anchorAt = new Date(a.occurred_at);
    let lastInbound: Date | null = null;
    for (const turn of THREADS[i]!) {
      const at = new Date(Math.min(now.getTime() - 5 * 60e3, turn.at < 0 ? now.getTime() + turn.at * 60e3 : anchorAt.getTime() + turn.at * 60e3));
      const id = `seed-spk-conv-${n++}`;
      if (turn.from === "customer") {
        lastInbound = at;
        await db.insert(schema.spokiMessages).values({ tenantId, direction: "inbound", purpose: "reply", providerMessageId: id, phone: a.phone, customerId: a.customer_id, orderId: a.order_id, body: turn.text, status: "received", statusAt: at, replyToMessageId: a.provider_message_id, occurredAt: at, createdAt: at }).onConflictDoNothing();
        if (a.order_id) await db.insert(schema.orderEvents).values({ tenantId, orderId: a.order_id, type: "whatsapp_reply", actorType: "integration", actorUserId: null, diff: {}, metadata: { text: turn.text, messageId: id, optOut: false }, createdAt: at });
      } else {
        await db.insert(schema.spokiMessages).values({ tenantId, direction: "outbound", purpose: "manual", providerMessageId: id, phone: a.phone, customerId: a.customer_id, orderId: a.order_id, body: turn.text, status: "read", statusAt: new Date(at.getTime() + 3 * 60e3), sentBy: users.care, occurredAt: at, createdAt: at }).onConflictDoNothing();
        if (a.order_id) await db.insert(schema.orderEvents).values({ tenantId, orderId: a.order_id, type: "whatsapp_message", actorType: "user", actorUserId: users.care, diff: {}, metadata: { purpose: "manual", template: null, messageId: id, provider: "spoki" }, createdAt: at });
      }
    }
    if (lastInbound) await db.update(schema.spokiMessages).set({ status: "replied", statusAt: lastInbound }).where(eq(schema.spokiMessages.id, a.id));
  }
  return true;
}

/**
 * An approved newsletter scheduled ten days ahead, so the campaign list keeps a "Scheduled" example
 * on a long-running demo (the seed's other scheduled campaign starts the day after the seed). Once, by name.
 */
export async function ensureScheduledShowcaseCampaign(db: Db, tenantId: string, now: Date, users: ShowcaseUsers): Promise<boolean> {
  if (await campaignId(db, tenantId, SCHEDULED_SHOWCASE_CAMPAIGN)) return false;
  const segId = await segmentId(db, tenantId, "Clienti ricorrenti");
  if (!segId) return false;
  const day = 864e5;
  const d = new Date(now.getTime() + 10 * day);
  // 10:00 in Rome is 08:00 or 09:00 UTC: the send window applies either way
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0));
  await db.insert(schema.retentionCampaigns).values({ tenantId, name: SCHEDULED_SHOWCASE_CAMPAIGN, segmentId: segId, channel: "email", message: "Ciao {first_name}, la collezione inverno arriva tra pochi giorni: la vedi in anteprima con il codice {code}.", discountCode: "INVERNO10", costPerMessageMinor: 1, attributionDays: 14, status: "scheduled", testSentAt: new Date(now.getTime() - 2 * day), testSentBy: users.marketing, submittedAt: new Date(now.getTime() - 2 * day), submittedBy: users.marketing, approvedAt: new Date(now.getTime() - day), approvedBy: users.owner, scheduledAt: at, scheduledBy: users.marketing, createdBy: users.marketing, createdAt: new Date(now.getTime() - 3 * day) });
  return true;
}
