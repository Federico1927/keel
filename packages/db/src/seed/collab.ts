import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { DEFAULT_TASK_RULES, localizedDefault } from "@keel/core";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

/**
 * Notifications, preferences, mentions, staff tasks and support for one demo tenant: default task
 * rules with the tasks they would have opened (inspections of received returns, overdue POs,
 * orders on hold), a few manual tasks, notes with mentions on a PO, a return and an order,
 * notifications of the new system types, an answered and an open support ticket, and two
 * suppressed addresses. Episodes follow the rule engine's format so the `tasks` tick does not
 * open the same tasks again.
 */
export async function seedCollab(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, locale: string, now: Date): Promise<void> {
  for (const table of [schema.tasks, schema.taskRules, schema.notificationPreferences, schema.emailSuppressions, schema.recordNotes, schema.mentions, schema.supportTickets]) await db.delete(table).where(eq(table.tenantId, tenantId));
  const it = key === "northwind";
  const dom = it ? "northwind" : "harborhome";
  const u = (role: string) => userIds[`${role}@${dom}.demo`] ?? null;
  const owner = u("owner")!;
  const ops = u("ops") ?? owner;
  // Harbor Home has no customer care user: the owner takes that part
  const care = u("care") ?? owner;
  const marketing = u("marketing") ?? owner;
  const platform = userIds["superadmin@keel.demo"] ?? null;
  const h = (n: number) => new Date(now.getTime() - n * 3600e3);
  const L = (en: string, itText: string) => (it ? itText : en);

  /* rules */
  const rules: Record<string, string> = {};
  for (const d of DEFAULT_TASK_RULES) {
    const [r] = await db.insert(schema.taskRules).values({ tenantId, key: d.key, ...d.rule, title: localizedDefault(d.title, locale), description: localizedDefault(d.description, locale), createdBy: owner, createdAt: h(24 * 40) }).returning({ id: schema.taskRules.id });
    rules[d.key] = r!.id;
  }
  const ruleTitle = (k: string) => localizedDefault(DEFAULT_TASK_RULES.find((d) => d.key === k)!.title, locale);
  const ruleDesc = (k: string) => localizedDefault(DEFAULT_TASK_RULES.find((d) => d.key === k)!.description, locale);

  /* tasks opened by the rules */
  const received = await db.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, receivedAt: schema.returnRequests.receivedAt }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, tenantId), eq(schema.returnRequests.status, "received"))).orderBy(asc(schema.returnRequests.number)).limit(6);
  for (const [i, r] of received.entries()) {
    const at = r.receivedAt ?? h(30);
    await db.insert(schema.tasks).values({ tenantId, entityType: "return", entityId: r.id, entityLabel: `R-${r.number}`, title: ruleTitle("return_received_inspect"), description: ruleDesc("return_received_inspect"), status: i === 0 ? "in_progress" : "open", assigneeId: i % 2 ? ops : (u("admin") ?? ops), dueAt: new Date(at.getTime() + 48 * 3600e3), ruleId: rules.return_received_inspect, episode: `received:${iso(r.receivedAt)}`, createdAt: at, updatedAt: at });
  }
  const inspected = await db.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, receivedAt: schema.returnRequests.receivedAt, updatedAt: schema.returnRequests.updatedAt }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, tenantId), inArray(schema.returnRequests.status, ["inspected", "refunded"]))).orderBy(desc(schema.returnRequests.receivedAt)).limit(4);
  for (const r of inspected) {
    const at = r.receivedAt ?? h(100);
    await db.insert(schema.tasks).values({ tenantId, entityType: "return", entityId: r.id, entityLabel: `R-${r.number}`, title: ruleTitle("return_received_inspect"), description: ruleDesc("return_received_inspect"), status: "done", closedReason: "auto", completedAt: new Date(at.getTime() + 20 * 3600e3), assigneeId: ops, dueAt: new Date(at.getTime() + 48 * 3600e3), ruleId: rules.return_received_inspect, episode: `received:${iso(r.receivedAt)}`, createdAt: at, updatedAt: at });
  }
  const latePos = await db.select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, expectedAt: schema.purchaseOrders.expectedAt, createdBy: schema.purchaseOrders.createdBy }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, tenantId), inArray(schema.purchaseOrders.status, ["sent", "confirmed", "in_transit", "partially_received"]), lt(schema.purchaseOrders.expectedAt, h(24)))).limit(4);
  for (const p of latePos) {
    const at = new Date(p.expectedAt!.getTime() + 25 * 3600e3);
    await db.insert(schema.tasks).values({ tenantId, entityType: "purchase_order", entityId: p.id, entityLabel: p.number, title: ruleTitle("po_overdue_follow_up"), description: ruleDesc("po_overdue_follow_up"), assigneeId: p.createdBy ?? ops, dueAt: new Date(at.getTime() + 24 * 3600e3), ruleId: rules.po_overdue_follow_up, episode: `open:${iso(p.expectedAt)}`, createdAt: at, updatedAt: at });
  }
  const held = await db.select({ id: schema.orders.id, name: schema.orders.name, since: schema.orders.statusChangedAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "on_hold"), lt(schema.orders.statusChangedAt, h(72)))).limit(4);
  for (const o of held) {
    const at = new Date(o.since.getTime() + 72 * 3600e3);
    await db.insert(schema.tasks).values({ tenantId, entityType: "order", entityId: o.id, entityLabel: o.name, title: ruleTitle("order_on_hold_review"), description: ruleDesc("order_on_hold_review"), assigneeId: care, dueAt: new Date(at.getTime() + 24 * 3600e3), ruleId: rules.order_on_hold_review, episode: `on_hold:${iso(o.since)}`, createdAt: at, updatedAt: at });
  }

  /* manual tasks: always present for both tenants */
  const [product] = await db.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(eq(schema.products.tenantId, tenantId)).orderBy(asc(schema.products.title)).limit(1);
  const [recent] = await db.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, tenantId)).orderBy(desc(schema.orders.placedAt)).limit(1);
  const manual: (typeof schema.tasks.$inferInsert)[] = [
    { tenantId, entityType: "product", entityId: product?.id ?? null, entityLabel: product?.title ?? null, title: L("Refresh the product photos and the size guide", "Aggiorna le foto prodotto e la guida taglie"), assigneeId: marketing, dueAt: new Date(now.getTime() + 3 * 864e5), createdBy: owner, createdAt: h(30), updatedAt: h(30) },
    { tenantId, entityType: "order", entityId: recent?.id ?? null, entityLabel: recent?.name ?? null, title: L("Call the customer back about the delivery address", "Richiama il cliente per l'indirizzo di consegna"), status: "done", closedReason: "done", completedAt: h(2), completedBy: care, assigneeId: care, dueAt: h(1), createdBy: ops, createdAt: h(20), updatedAt: h(2) },
    { tenantId, title: L("Prepare the monthly stock count", "Prepara l'inventario di fine mese"), description: L("Count the fast movers in every location and compare with Keel.", "Conta gli articoli più venduti in ogni magazzino e confronta con Keel."), assigneeId: ops, dueAt: h(6), createdBy: owner, createdAt: h(24 * 5), updatedAt: h(24 * 5) },
  ];
  await db.insert(schema.tasks).values(manual);

  /* preferences: the owner reads the daily digest, operations does not want mention emails */
  await db.insert(schema.notificationPreferences).values([
    { tenantId, userId: owner, type: "digest", email: true },
    { tenantId, userId: ops, type: "mention", email: false },
    { tenantId, userId: ops, type: "sync_delay", slack: true },
  ]);

  /* notes with mentions on a PO, a return and an order, and the inbox rows they produce */
  const mention = (id: string, name: string) => `@[${name}](${id})`;
  const [po] = await db.select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, tenantId)).orderBy(desc(schema.purchaseOrders.createdAt)).limit(1);
  const [ret] = await db.select({ id: schema.returnRequests.id, number: schema.returnRequests.number }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, tenantId)).orderBy(desc(schema.returnRequests.requestedAt)).limit(1);
  const names = Object.fromEntries((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, [ops, care, owner]))).map((r) => [r.id, r.name ?? ""]));
  const notes: { entityType: "purchase_order" | "return" | "order"; entityId: string; label: string; link: string; author: string; target: string; body: string; at: Date }[] = [];
  if (po) notes.push({ entityType: "purchase_order", entityId: po.id, label: po.number, link: `/purchasing/${po.id}`, author: owner, target: ops, body: L(`${mention(ops, names[ops]!)} the supplier asked to split the delivery in two: can you check the dock schedule?`, `${mention(ops, names[ops]!)} il fornitore chiede di dividere la consegna in due: puoi verificare il calendario di ricevimento?`), at: h(5) });
  if (ret) notes.push({ entityType: "return", entityId: ret.id, label: `R-${ret.number}`, link: `/returns/${ret.id}`, author: ops, target: care, body: L(`${mention(care, names[care]!)} the customer sent photos by email, please attach them before the inspection.`, `${mention(care, names[care]!)} il cliente ha mandato le foto per email, allegale prima dell'ispezione.`), at: h(3) });
  if (recent) notes.push({ entityType: "order", entityId: recent.id, label: recent.name, link: `/orders/${recent.id}`, author: care, target: ops, body: L(`${mention(ops, names[ops]!)} gift wrapping requested, please add a note on the packing slip.`, `${mention(ops, names[ops]!)} richiesta confezione regalo, aggiungi una nota sulla bolla.`), at: h(1) });
  for (const n of notes) {
    if (n.author === n.target) continue;
    let noteId: string;
    if (n.entityType === "order") {
      const [row] = await db.insert(schema.orderNotes).values({ tenantId, orderId: n.entityId, authorId: n.author, body: n.body, mentions: [n.target], createdAt: n.at }).returning({ id: schema.orderNotes.id });
      noteId = row!.id;
    } else {
      const [row] = await db.insert(schema.recordNotes).values({ tenantId, entityType: n.entityType, entityId: n.entityId, authorId: n.author, body: n.body, mentions: [n.target], createdAt: n.at }).returning({ id: schema.recordNotes.id });
      noteId = row!.id;
    }
    await db.insert(schema.mentions).values({ tenantId, userId: n.target, authorId: n.author, entityType: n.entityType, entityId: n.entityId, entityLabel: n.label, noteId, excerpt: n.body, link: n.link, createdAt: n.at });
    await db.insert(schema.notifications).values({ tenantId, userId: n.target, type: "mention", title: `${names[n.author] ?? ""} · ${n.label}`, body: n.body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, "@$1").slice(0, 140), link: n.link, metadata: { entityType: n.entityType, entityId: n.entityId, noteId }, delivered: n.target === ops ? {} : { email: "mock" }, createdAt: n.at });
  }

  /* notifications of the system types */
  const [lateCount] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.status, ["confirmed", "fulfilling"]), lt(schema.orders.placedAt, h(48))));
  const sysRows: (typeof schema.notifications.$inferInsert)[] = [];
  for (const userId of [...new Set([owner, ops])]) {
    sysRows.push(
      { tenantId, userId, type: "stock_critical_no_po", severity: "critical", title: "3", body: L("Selling variants at critical cover with nothing on order", "Varianti in vendita a copertura critica senza ordini d'acquisto"), link: "/inventory/planning", metadata: { count: 3 }, createdAt: h(2) },
      { tenantId, userId, type: "late_to_ship", severity: "warning", title: String(Math.max(1, lateCount?.n ?? 1)), body: "48h", link: "/orders?status=confirmed&sort=placed_asc", metadata: { count: lateCount?.n ?? 1, thresholdHours: 48 }, createdAt: h(4) },
      { tenantId, userId, type: "sync_delay", severity: "warning", title: "meta", body: "+3h", link: "/integrations#meta", metadata: { source: "meta", minutesLate: 190 }, readAt: h(20), delivered: userId === ops ? { slack: "not_configured" } : {}, createdAt: h(22) },
    );
  }
  sysRows.push({ tenantId, userId: ops, type: "task_assigned", title: ruleTitle("return_received_inspect"), body: received[0] ? `R-${received[0].number}` : null, link: received[0] ? `/returns/${received[0].id}` : "/tasks", metadata: {}, createdAt: h(6) });
  await db.insert(schema.notifications).values(sysRows);

  /* support: one answered ticket and one open ticket with a small attachment */
  const [t1] = await db.insert(schema.supportTickets).values({ tenantId, number: 1, subject: L("How do I connect a Google Ads manager account?", "Come collego un account manager di Google Ads?"), category: "question", status: "answered", createdBy: owner, lastMessageAt: h(26), createdAt: h(50), updatedAt: h(26) }).returning({ id: schema.supportTickets.id });
  await db.insert(schema.supportMessages).values([
    { tenantId, ticketId: t1!.id, authorId: owner, side: "tenant", body: L("Our agency manages the ads from an MCC. Which customer ID do we paste in Integrations?", "La nostra agenzia gestisce le campagne da un MCC. Quale customer ID incolliamo in Integrazioni?"), createdAt: h(50) },
    { tenantId, ticketId: t1!.id, authorId: platform, side: "platform", body: L("Paste the ID of the advertiser account and the MCC as login customer ID; the guide under Integrations → Google shows both fields.", "Incolla l'ID dell'account inserzionista e l'MCC come login customer ID; la guida in Integrazioni → Google mostra entrambi i campi."), createdAt: h(26) },
  ]);
  await db.insert(schema.notifications).values({ tenantId, userId: owner, type: "support_reply", title: L("#1 · How do I connect a Google Ads manager account?", "#1 · Come collego un account manager di Google Ads?"), body: null, link: `/support/${t1!.id}`, metadata: { ticketId: t1!.id }, createdAt: h(26) });
  const [t2] = await db.insert(schema.supportTickets).values({ tenantId, number: 2, subject: L("Stock export does not match the warehouse count", "L'export dello stock non coincide con il conteggio del magazzino"), category: "problem", status: "open", createdBy: ops, lastMessageAt: h(3), createdAt: h(3), updatedAt: h(3) }).returning({ id: schema.supportTickets.id });
  const csv = Buffer.from(L("sku,keel,warehouse\nSKU-001,12,10\nSKU-002,4,4\n", "sku,keel,magazzino\nSKU-001,12,10\nSKU-002,4,4\n"), "utf8");
  await db.insert(schema.supportMessages).values({ tenantId, ticketId: t2!.id, authorId: ops, side: "tenant", body: L("Two SKUs differ after yesterday's receipt, file attached.", "Due SKU non tornano dopo il ricevimento di ieri, file allegato."), attachmentName: "stock-diff.csv", attachmentType: "text/csv", attachmentSize: csv.length, attachmentData: csv, createdAt: h(3) });

  /* suppression list */
  await db.insert(schema.emailSuppressions).values([
    { tenantId, email: `old-supplier@${dom}.example`, reason: "bounce", category: "all", source: "provider", createdAt: h(24 * 12) },
    { tenantId, email: `viewer@${dom}.demo`, reason: "unsubscribe", category: "digest", source: "link", createdAt: h(24 * 3) },
  ]);
  // customers who asked not to be contacted: an unsubscribe from campaign emails and a phone blocked by hand (SMS, WhatsApp) (#34)
  const contacts = await db.select({ email: schema.customers.email, phone: schema.customers.phoneE164 }).from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), eq(schema.customers.acceptsMarketing, true), isNotNull(schema.customers.email), isNotNull(schema.customers.phoneE164))).orderBy(schema.customers.id).limit(2);
  if (contacts.length === 2) {
    await db.insert(schema.emailSuppressions).values([
      { tenantId, email: contacts[0]!.email!.toLowerCase(), reason: "unsubscribe", category: "marketing", source: "link", createdAt: h(24 * 6) },
      { tenantId, email: contacts[1]!.phone!, identityType: "phone", reason: "manual", category: "all", source: "app", note: L("Asked on the phone not to receive messages", "Ha chiesto al telefono di non ricevere messaggi"), createdBy: owner, createdAt: h(24 * 9) },
    ]);
  }
}
