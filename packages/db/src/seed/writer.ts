import type { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema";
import type { TenantDataset } from "./generator";

type Db = ReturnType<typeof drizzle<typeof schema>>;

const CHUNK = 500;

async function bulk(db: Db, table: PgTable, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table).values(rows.slice(i, i + CHUNK) as any);
  }
}

/** Insert order respects foreign keys. */
export const WRITE_ORDER: [keyof TenantDataset, PgTable][] = [
  ["locations", schema.locations],
  ["products", schema.products],
  ["productVariants", schema.productVariants],
  ["inventoryLevels", schema.inventoryLevels],
  ["customers", schema.customers],
  ["campaigns", schema.campaigns],
  ["adMetricsDaily", schema.adMetricsDaily],
  ["adCreatives", schema.adCreatives],
  ["adCreativeMetricsDaily", schema.adCreativeMetricsDaily],
  ["campaignProductLinks", schema.campaignProductLinks],
  ["discountPools", schema.discountPools],
  ["discounts", schema.discounts],
  ["stateRules", schema.stateRules],
  ["shipmentStatusMappings", schema.shipmentStatusMappings],
  ["costSettings", schema.costSettings],
  ["periodCosts", schema.periodCosts],
  ["returnReasons", schema.returnReasons],
  ["suppliers", schema.suppliers],
  ["orders", schema.orders],
  ["orderLines", schema.orderLines],
  ["orderEvents", schema.orderEvents],
  ["orderNotes", schema.orderNotes],
  ["orderDiscounts", schema.orderDiscounts],
  ["orderAttribution", schema.orderAttribution],
  ["touchpoints", schema.touchpoints],
  ["shipments", schema.shipments],
  ["shipmentSourceStates", schema.shipmentSourceStates],
  ["shipmentEvents", schema.shipmentEvents],
  ["returnRequests", schema.returnRequests],
  ["returnLines", schema.returnLines],
  ["purchaseOrders", schema.purchaseOrders],
  ["purchaseOrderLines", schema.purchaseOrderLines],
  ["supplierPayments", schema.supplierPayments],
  ["backorders", schema.backorders],
  ["inventoryMovements", schema.inventoryMovements],
  ["segments", schema.segments],
  ["segmentMemberships", schema.segmentMemberships],
  ["notifications", schema.notifications],
  ["integrations", schema.integrations],
  ["integrationHealth", schema.integrationHealth],
  ["webhookEvents", schema.webhookEvents],
  ["syncRuns", schema.syncRuns],
  ["platformWrites", schema.platformWrites],
  ["inventoryDrift", schema.inventoryDrift],
  ["auditLogs", schema.auditLogs],
];

export async function writeDataset(db: Db, ds: TenantDataset): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [key, table] of WRITE_ORDER) {
    const rows = ds[key];
    await bulk(db, table, rows);
    counts[key] = rows.length;
  }
  return counts;
}
