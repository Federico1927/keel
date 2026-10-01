import { and, eq, inArray, isNotNull, ne, or, schema, sql } from "@keel/db";
import type { ServiceContext } from "../context";

export interface HistoryOrder {
  id: string;
  name: string;
  placedAt: Date;
  status: string;
  totalMinor: number;
  currency: string;
  matchedVia: "customer" | "email" | "phone" | "address" | "name" | "linked";
}
export interface CustomerHistory {
  identified: boolean;
  orders: HistoryOrder[];
  hops: number;
  stats: { total: number; delivered: number; inProgress: number; returned: number; cancelled: number; totalSpentMinor: number };
}

const CAP = 300;
const MAX_HOPS = 3;

/**
 * Transitive customer history on strong keys (platform customer id, email, phone, address),
 * up to 3 hops, capped; weak match on name+zip is reported but never expanded.
 */
export async function customerOrderHistory(ctx: ServiceContext, orderId: string): Promise<CustomerHistory> {
  const [seed] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!seed) throw new Error("order_not_found");
  const customerIds = new Set<string>(seed.customerId ? [seed.customerId] : []);
  const emails = new Set<string>(seed.emailNormalized ? [seed.emailNormalized] : []);
  const phones = new Set<string>(seed.phoneE164 ? [seed.phoneE164] : []);
  const addresses = new Set<string>(seed.addressKey ? [seed.addressKey] : []);
  const identified = customerIds.size + emails.size + phones.size + addresses.size > 0;
  const found = new Map<string, HistoryOrder>();
  const seedKeys = { customerIds: new Set(customerIds), emails: new Set(emails), phones: new Set(phones), addresses: new Set(addresses) };
  let hops = 0;
  if (identified) {
    for (; hops <= MAX_HOPS && found.size < CAP; hops++) {
      const conds = [];
      if (customerIds.size) conds.push(inArray(schema.orders.customerId, [...customerIds]));
      if (emails.size) conds.push(inArray(schema.orders.emailNormalized, [...emails]));
      if (phones.size) conds.push(inArray(schema.orders.phoneE164, [...phones]));
      if (addresses.size) conds.push(inArray(schema.orders.addressKey, [...addresses]));
      if (!conds.length) break;
      const exclude = [seed.id, ...found.keys()];
      const rows = await ctx.tx
        .select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, status: schema.orders.status, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, customerId: schema.orders.customerId, emailNormalized: schema.orders.emailNormalized, phoneE164: schema.orders.phoneE164, addressKey: schema.orders.addressKey })
        .from(schema.orders)
        .where(and(eq(schema.orders.tenantId, ctx.tenantId), or(...conds), exclude.length ? sql`${schema.orders.id} <> all(${sql.raw(`array[${exclude.map((e) => `'${e}'::uuid`).join(",")}]`)})` : ne(schema.orders.id, seed.id)))
        .limit(CAP - found.size);
      if (rows.length === 0) break;
      let newKeys = false;
      for (const r of rows) {
        const via: HistoryOrder["matchedVia"] =
          r.customerId && seedKeys.customerIds.has(r.customerId) ? "customer" : r.emailNormalized && seedKeys.emails.has(r.emailNormalized) ? "email" : r.phoneE164 && seedKeys.phones.has(r.phoneE164) ? "phone" : r.addressKey && seedKeys.addresses.has(r.addressKey) ? "address" : "linked";
        found.set(r.id, { id: r.id, name: r.name, placedAt: r.placedAt, status: r.status, totalMinor: r.totalMinor, currency: r.currency, matchedVia: via });
        for (const [set, v] of [[customerIds, r.customerId], [emails, r.emailNormalized], [phones, r.phoneE164], [addresses, r.addressKey]] as const) {
          if (v && !set.has(v)) {
            set.add(v);
            newKeys = true;
          }
        }
      }
      if (!newKeys) {
        hops++;
        break;
      }
    }
  }
  // Weak match: same name + zip, not expanded.
  if (seed.nameZipKey && found.size < CAP) {
    const weak = await ctx.tx
      .select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, status: schema.orders.status, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency })
      .from(schema.orders)
      .where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.nameZipKey, seed.nameZipKey), ne(schema.orders.id, seed.id)))
      .limit(20);
    for (const r of weak) if (!found.has(r.id)) found.set(r.id, { ...r, matchedVia: "name" });
  }
  // orders replaced by an edit are lineage of the replacement, not separate purchases or cancellations
  const foundIds = [...found.keys()];
  const replaced = foundIds.length ? await ctx.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, foundIds), isNotNull(schema.orders.replacedByOrderId))) : [];
  for (const r of replaced) found.delete(r.id);
  const orders = [...found.values()].sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
  const stats = { total: orders.length, delivered: 0, inProgress: 0, returned: 0, cancelled: 0, totalSpentMinor: 0 };
  for (const o of orders) {
    if (o.status === "delivered") stats.delivered++;
    else if (o.status === "cancelled") stats.cancelled++;
    else if (o.status === "returned" || o.status === "refunded" || o.status === "returned_partial") stats.returned++;
    else stats.inProgress++;
    if (!["cancelled", "refunded", "returned"].includes(o.status)) stats.totalSpentMinor += o.totalMinor;
  }
  return { identified, orders, hops: Math.max(0, hops - 1), stats };
}
