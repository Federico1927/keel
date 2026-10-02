import { and, eq, gte } from "drizzle-orm";
import type { MockTrafficOrder } from "@hullwise/integrations";
import type { DbExecutor } from "./client";
import * as schema from "./schema";

/**
 * The online orders the GA4 simulator builds traffic from (#86). One query for the seed and for the
 * adapter factory, so a resync of the demo writes exactly the numbers the seed wrote.
 */
export async function mockTrafficOrders(db: DbExecutor, tenantId: string, since: Date): Promise<MockTrafficOrder[]> {
  return db
    .select({ placedAt: schema.orders.placedAt, landingSite: schema.orders.landingSite, channel: schema.orderAttribution.channel, utmSource: schema.orderAttribution.utmSource, utmMedium: schema.orderAttribution.utmMedium, utmCampaign: schema.orderAttribution.utmCampaign })
    .from(schema.orders)
    .leftJoin(schema.orderAttribution, eq(schema.orderAttribution.orderId, schema.orders.id))
    .where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.sourceChannel, "web"), gte(schema.orders.placedAt, since)))
    .orderBy(schema.orders.placedAt, schema.orders.id);
}
