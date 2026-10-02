import { sql, type SQL } from "@hullwise/db";

/**
 * SQL of the subscription segment fields (addon.subscriptions, #67) over the CRM profile alias `p`.
 * Each reads the customer's most relevant contract (live first, then the latest); kept apart from
 * the core field map so the two evolve independently.
 */
const best = (col: string) => sql.raw(`(select sc.${col} from subscription_contracts sc where sc.customer_id = p.customer_id order by (sc.status in ('active', 'paused')) desc, sc.activated_at desc limit 1)`);
export const SUBSCRIPTION_FIELD_SQL: Record<string, SQL> = {
  subscription_status: sql`coalesce(${best("status")}, 'none')`,
  subscription_paused_days: sql`(select floor(extract(epoch from (now() - min(sc.paused_at))) / 86400)::int from subscription_contracts sc where sc.customer_id = p.customer_id and sc.status = 'paused')`,
  subscription_payment_failed: sql`exists (select 1 from subscription_contracts sc where sc.customer_id = p.customer_id and sc.status in ('active', 'paused') and sc.payment_failing_since is not null)`,
  subscription_renewals: sql`coalesce((select max(sc.renewals_count) from subscription_contracts sc where sc.customer_id = p.customer_id and sc.status in ('active', 'paused')), 0)`,
  subscription_next_renewal_days: sql`(select floor(extract(epoch from (min(sc.next_billing_at) - now())) / 86400)::int from subscription_contracts sc where sc.customer_id = p.customer_id and sc.status = 'active')`,
  subscription_churn_risk: sql`(select sc.churn_risk from subscription_contracts sc where sc.customer_id = p.customer_id and sc.status in ('active', 'paused') order by sc.churn_retention_bps asc nulls last limit 1)`,
};
