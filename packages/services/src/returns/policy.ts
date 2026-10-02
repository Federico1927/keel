import { and, eq, schema, sql } from "@hullwise/db";
import { customerReturnRisk, parseReturnPolicy, returnPolicySchema, selectAutomations, type CustomerReturnStats, type ReturnPolicy, type RiskLevel, type TenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { ReturnError } from "./errors";

export async function getReturnPolicy(ctx: ServiceContext): Promise<ReturnPolicy> {
  const [row] = await ctx.tx.select({ policy: schema.returnPolicies.policy }).from(schema.returnPolicies).where(eq(schema.returnPolicies.tenantId, ctx.tenantId)).limit(1);
  return parseReturnPolicy(row?.policy);
}

export async function saveReturnPolicy(ctx: ServiceContext, raw: unknown): Promise<ReturnPolicy> {
  const parsed = returnPolicySchema.safeParse(raw);
  if (!parsed.success) throw new ReturnError("invalid_input");
  const ids = parsed.data.automations.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new ReturnError("invalid_input");
  await ctx.tx
    .insert(schema.returnPolicies)
    .values({ tenantId: ctx.tenantId, policy: parsed.data, updatedBy: ctx.actor.userId })
    .onConflictDoUpdate({ target: schema.returnPolicies.tenantId, set: { policy: parsed.data, updatedBy: ctx.actor.userId, updatedAt: ctx.now ?? new Date() } });
  return parsed.data;
}

/** Who the customer of an order is, for history: the customer record, else the normalized email. */
async function customerKey(ctx: ServiceContext, orderId: string): Promise<{ customerId: string | null; email: string | null }> {
  const [o] = await ctx.tx.select({ customerId: schema.orders.customerId, email: schema.orders.email }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  return { customerId: o?.customerId ?? null, email: o?.email?.trim().toLowerCase() ?? null };
}

const sameCustomer = (k: { customerId: string | null; email: string | null }) =>
  k.customerId ? sql`o.customer_id = ${k.customerId}` : k.email ? sql`lower(trim(o.email)) = ${k.email}` : sql`false`;

/** Return history of the customer of an order over the policy window, excluding one return if given. */
export async function customerReturnStats(ctx: ServiceContext, policy: ReturnPolicy, orderId: string, excludeReturnId?: string | null): Promise<CustomerReturnStats & { returnDates: Date[] }> {
  const k = await customerKey(ctx, orderId);
  const since = new Date((ctx.now ?? new Date()).getTime() - policy.risk.days * 864e5);
  const bought = await ctx.tx.execute<{ orders: number; items: number }>(sql`
    select count(distinct o.id)::int as orders, coalesce(sum(l.quantity), 0)::int as items
    from orders o join order_lines l on l.order_id = o.id
    where o.tenant_id = ${ctx.tenantId} and ${sameCustomer(k)} and o.status <> 'cancelled' and l.is_ancillary = false and o.placed_at >= ${since}`);
  const returned = await ctx.tx.execute<{ id: string; items: number; value: number; quick: boolean; requested_at: string }>(sql`
    select r.id, coalesce(sum(rl.quantity), 0)::int as items, max(coalesce(r.refunded_amount_minor, r.proposed_amount_minor))::int as value,
      bool_or(r.fault = 'customer' and sh.delivered_at is not null and r.requested_at - sh.delivered_at <= make_interval(days => ${policy.risk.quickReturnDays})) as quick,
      max(r.requested_at) as requested_at
    from return_requests r join orders o on o.id = r.order_id
    left join return_lines rl on rl.return_id = r.id
    left join lateral (select s.delivered_at from shipments s where s.order_id = o.id order by s.created_at desc limit 1) sh on true
    where r.tenant_id = ${ctx.tenantId} and ${sameCustomer(k)} and r.status <> 'rejected' and r.requested_at >= ${since}
      ${excludeReturnId ? sql`and r.id <> ${excludeReturnId}` : sql``}
    group by r.id`);
  const rows = returned.rows;
  return {
    ordersCount: Number(bought.rows[0]?.orders ?? 0),
    itemsBought: Number(bought.rows[0]?.items ?? 0),
    itemsReturned: rows.reduce((s, r) => s + Number(r.items), 0),
    returnsCount: rows.length,
    returnedValueMinor: rows.reduce((s, r) => s + Number(r.value ?? 0), 0),
    quickCustomerFaultReturns: rows.filter((r) => r.quick).length,
    returnDates: rows.map((r) => new Date(r.requested_at)),
  };
}

export async function customerRiskForOrder(ctx: ServiceContext, policy: ReturnPolicy, orderId: string, excludeReturnId?: string | null) {
  const stats = await customerReturnStats(ctx, policy, orderId, excludeReturnId);
  return { stats, ...customerReturnRisk(stats, policy.risk) };
}

/**
 * Runs when a return is created: stores the customer risk, then applies the matching
 * automations (flag, fault, approve, reject, returnless). Decisions go through the normal
 * workflow, so the order, the stock and the store follow as if a person had clicked.
 */
export async function applyReturnAutomations(
  ctx: ServiceContext,
  settings: TenantSettings,
  returnId: string,
  transition: (to: "approved" | "rejected" | "received" | "inspected" | "refunded" | "voucher_issued", note: string) => Promise<unknown>,
): Promise<{ risk: RiskLevel; applied: string[] }> {
  void settings;
  const [r] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!r) throw new ReturnError("return_not_found");
  const policy = await getReturnPolicy(ctx);
  const risk = await customerRiskForOrder(ctx, policy, r.orderId, r.id);
  const types = await ctx.tx.execute<{ product_type: string | null }>(sql`
    select distinct p.product_type from return_lines rl join order_lines ol on ol.id = rl.order_line_id left join products p on p.id = ol.product_id where rl.return_id = ${r.id}`);
  const rules = selectAutomations(policy.automations, {
    amountMinor: r.proposedAmountMinor,
    reasonCode: r.reasonCode,
    resolution: r.resolution,
    source: r.source,
    productTypes: types.rows.map((t) => t.product_type).filter((t): t is string => Boolean(t)),
    risk: risk.level,
    previousReturns: risk.stats.returnsCount,
  });
  const patch: Partial<typeof schema.returnRequests.$inferInsert> = { riskLevel: risk.level, riskReasons: risk.reasons, automations: rules.map((a) => ({ id: a.id, name: a.name, action: a.action })) };
  for (const a of rules) {
    if (a.action === "flag") patch.needsReview = true;
    if (a.action === "set_fault" && a.fault) patch.fault = a.fault;
  }
  await ctx.tx.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, r.id));
  const decision = rules.find((a) => a.action === "approve" || a.action === "reject" || a.action === "returnless");
  if (decision) {
    const note = `${decision.name}${decision.note ? `: ${decision.note}` : ""}`;
    if (decision.action === "approve") await transition("approved", note);
    if (decision.action === "reject") await transition("rejected", note);
    if (decision.action === "returnless") {
      // keep the item: approve, mark received without restock, accept the full value, close by the requested resolution
      await ctx.tx.update(schema.returnRequests).set({ returnless: true }).where(eq(schema.returnRequests.id, r.id));
      await transition("approved", note);
      await transition("received", note);
      await transition("inspected", note);
      if (r.resolution === "voucher") await transition("voucher_issued", note);
      else if (r.resolution === "refund") await transition("refunded", note);
    }
  }
  return { risk: risk.level, applied: rules.map((a) => a.id) };
}

export async function setReturnReview(ctx: ServiceContext, returnId: string, needsReview: boolean): Promise<void> {
  await ctx.tx.update(schema.returnRequests).set({ needsReview }).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId)));
}
