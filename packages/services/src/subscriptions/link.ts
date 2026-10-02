import { and, eq, or, schema, sql } from "@hullwise/db";
import type { ServiceContext } from "../context";

/**
 * Flags the orders a contract created (origin order, orders of successful charges, orders already
 * pointing at it): the contract id, whether it is the first order, and the renewal number in date
 * order (0 = first order). Core P/L and attribution split subscription orders on these columns.
 */
export async function linkContractOrders(ctx: ServiceContext, contractId: string): Promise<void> {
  await ctx.tx.execute(sql`
    with ids as (
      select origin_order_id as id from subscription_contracts where id = ${contractId} and origin_order_id is not null
      union select order_id from subscription_billing_attempts where contract_id = ${contractId} and order_id is not null and status = 'success'
      union select id from orders where subscription_contract_id = ${contractId} and tenant_id = ${ctx.tenantId}
    ), numbered as (
      select o.id, (row_number() over (order by o.placed_at, o.order_number) - 1)::int as n from orders o join ids on ids.id = o.id where o.tenant_id = ${ctx.tenantId}
    )
    update orders o set subscription_contract_id = ${contractId}, is_first_subscription_order = (numbered.n = 0), renewal_number = numbered.n
    from numbered where o.id = numbered.id and (o.subscription_contract_id is distinct from ${contractId} or o.renewal_number is distinct from numbered.n)`);
  await ctx.tx.execute(sql`update subscription_contracts c set renewals_count = coalesce((select count(*) from orders o where o.subscription_contract_id = c.id and o.renewal_number > 0 and o.tenant_id = ${ctx.tenantId}), 0)::int where c.id = ${contractId}`);
}

/**
 * Called by the core order import: an order the subscription app already reported (as a contract's
 * origin order or a successful charge) is flagged as soon as it arrives, whichever comes first.
 * A no-op for stores without subscription data.
 */
export async function linkSubscriptionOrderOnImport(ctx: ServiceContext, orderId: string, orderExternalId: string | null): Promise<void> {
  if (!orderExternalId) return;
  const contracts = await ctx.tx.select({ id: schema.subscriptionContracts.id }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.originOrderExternalId, orderExternalId)));
  const attempts = await ctx.tx.select({ id: schema.subscriptionBillingAttempts.id, contractId: schema.subscriptionBillingAttempts.contractId }).from(schema.subscriptionBillingAttempts).where(and(eq(schema.subscriptionBillingAttempts.tenantId, ctx.tenantId), eq(schema.subscriptionBillingAttempts.orderExternalId, orderExternalId), eq(schema.subscriptionBillingAttempts.status, "success")));
  if (!contracts.length && !attempts.length) return;
  if (contracts.length) await ctx.tx.update(schema.subscriptionContracts).set({ originOrderId: orderId }).where(or(...contracts.map((c) => eq(schema.subscriptionContracts.id, c.id))));
  if (attempts.length) await ctx.tx.update(schema.subscriptionBillingAttempts).set({ orderId }).where(or(...attempts.map((a) => eq(schema.subscriptionBillingAttempts.id, a.id))));
  for (const id of new Set([...contracts.map((c) => c.id), ...attempts.map((a) => a.contractId)])) await linkContractOrders(ctx, id);
}
