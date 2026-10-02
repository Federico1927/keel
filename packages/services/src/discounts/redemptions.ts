import { schema, sql } from "@keel/db";
import type { ServiceContext } from "../context";

/**
 * Links pool codes to the first order that used them (order discount codes, case-insensitive): the code
 * becomes `redeemed`, with that order. Runs for one order on import and for everything in the nightly
 * catalog run; a code already linked keeps its order. Returns how many codes were linked.
 */
export async function linkPoolRedemptions(ctx: ServiceContext, scope: { orderId?: string; poolId?: string } = {}): Promise<number> {
  const orderFilter = scope.orderId ? sql`and o.id = ${scope.orderId}` : sql``;
  const poolFilter = scope.poolId ? sql`and d.pool_id = ${scope.poolId}` : sql``;
  const r = await ctx.tx.execute(sql`
    update ${schema.discounts} d set redeemed_order_id = x.order_id, redeemed_at = x.placed_at, used_count = greatest(d.used_count, 1), updated_at = now()
    from (
      select distinct on (upper(od.code)) upper(od.code) as code, o.id as order_id, o.placed_at
      from order_discounts od join orders o on o.id = od.order_id
      where od.tenant_id = ${ctx.tenantId} and o.replaced_by_order_id is null ${orderFilter}
      order by upper(od.code), o.placed_at
    ) x
    where d.tenant_id = ${ctx.tenantId} and d.pool_id is not null and d.redeemed_order_id is null and upper(d.code) = x.code ${poolFilter}`);
  return r.rowCount ?? 0;
}
