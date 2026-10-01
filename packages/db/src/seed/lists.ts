import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Saved views of the demo lists (shared ones every member sees, a private one per owner) and one
 * finished background export, so the toolbar and the download page have something to show.
 */
export async function seedLists(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  for (const table of [schema.savedViews, schema.listExports]) await db.delete(table).where(eq(table.tenantId, tenantId));
  const it = key === "northwind";
  const dom = it ? "northwind" : "harborhome";
  const owner = userIds[`owner@${dom}.demo`]!;
  const ops = userIds[`ops@${dom}.demo`] ?? owner;
  const L = (en: string, itText: string) => (it ? itText : en);
  const at = (days: number) => new Date(now.getTime() - days * 864e5);
  await db.insert(schema.savedViews).values([
    { tenantId, pageKey: "orders", name: L("To ship", "Da spedire"), query: "status=confirmed,fulfilling&sort=placed_asc", ownerUserId: ops, isShared: true, createdAt: at(20), updatedAt: at(20) },
    { tenantId, pageKey: "orders", name: L("On hold", "In attesa"), query: "status=on_hold", ownerUserId: ops, isShared: true, createdAt: at(18), updatedAt: at(18) },
    { tenantId, pageKey: "orders", name: L("Biggest orders", "Ordini più alti"), query: "sort=total_desc", ownerUserId: owner, isShared: false, createdAt: at(10), updatedAt: at(10) },
    { tenantId, pageKey: "products", name: L("Critical stock", "Stock critico"), query: "risk=critical", ownerUserId: ops, isShared: true, createdAt: at(15), updatedAt: at(15) },
    { tenantId, pageKey: "returns", name: L("Open returns", "Resi aperti"), query: "status=open", ownerUserId: ops, isShared: true, createdAt: at(12), updatedAt: at(12) },
    { tenantId, pageKey: "customers", name: L("Champions", "Campioni"), query: "tier=champions&sort=total_spent", ownerUserId: owner, isShared: true, createdAt: at(9), updatedAt: at(9) },
  ]);
  const csv = "order,placed_at,status\n";
  await db.insert(schema.listExports).values({ tenantId, userId: owner, list: "orders", query: "status=delivered", status: "done", rowCount: 0, fileName: "orders-demo.csv", content: csv, createdAt: at(3), completedAt: at(3), downloadedAt: at(3) });
}
