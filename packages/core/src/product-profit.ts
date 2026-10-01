import { trafficLight, type TrafficLight } from "./campaigns";
import { allocateMinor } from "./pnl-periods";
import { safeDiv } from "./money";
import type { StockRisk } from "./inventory";

/**
 * Product profitability over a period: sales from the order lines of sale orders, the ad spend
 * of the campaigns linked to each product, and what to do with its stock.
 */

export interface ProductSaleLine {
  orderId: string;
  productId: string;
  quantity: number;
  /** Line total after line discounts, tax included when prices include tax. */
  lineGrossMinor: number;
  unitCostMinor: number | null;
  /** Order net revenue / order gross revenue: removes tax and refunds pro rata, as the P/L does. */
  netRatio: number;
  /** 1 − returned fraction of the order: cost of goods kept, as in `orderEconomics`. */
  keep: number;
}

export interface ProductSales {
  productId: string;
  units: number;
  orders: number;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  cogsMinor: number;
  /** Units sold on lines without a cost. */
  unitsWithoutCost: number;
}

export function productSales(lines: readonly ProductSaleLine[]): Map<string, ProductSales> {
  const acc = new Map<string, ProductSales & { net: number; cogs: number; orderSet: Set<string> }>();
  for (const l of lines) {
    const cur = acc.get(l.productId) ?? { productId: l.productId, units: 0, orders: 0, grossRevenueMinor: 0, netRevenueMinor: 0, cogsMinor: 0, unitsWithoutCost: 0, net: 0, cogs: 0, orderSet: new Set<string>() };
    cur.units += l.quantity;
    cur.orderSet.add(l.orderId);
    cur.grossRevenueMinor += l.lineGrossMinor;
    cur.net += l.lineGrossMinor * l.netRatio;
    if (l.unitCostMinor === null) cur.unitsWithoutCost += l.quantity;
    else cur.cogs += l.quantity * l.unitCostMinor * l.keep;
    acc.set(l.productId, cur);
  }
  const out = new Map<string, ProductSales>();
  for (const [k, v] of acc) out.set(k, { productId: v.productId, units: v.units, orders: v.orderSet.size, grossRevenueMinor: v.grossRevenueMinor, netRevenueMinor: Math.round(v.net), cogsMinor: Math.round(v.cogs), unitsWithoutCost: v.unitsWithoutCost });
  return out;
}

export interface CampaignSpend {
  campaignId: string;
  spendMinor: number;
  /** Products linked to the campaign (campaign_product_links). */
  productIds: readonly string[];
}

/**
 * Splits each campaign's spend over its linked products in proportion to their net revenue in
 * the period (evenly when none sold). Spend of campaigns without a linked product is
 * unattributed. The parts always add up to the total spend.
 */
export function allocateAdSpend(campaigns: readonly CampaignSpend[], weightOf: (productId: string) => number): { byProduct: Map<string, number>; byCampaignProduct: { campaignId: string; productId: string; spendMinor: number }[]; unattributedMinor: number; unlinkedCampaigns: number } {
  const byProduct = new Map<string, number>();
  const byCampaignProduct: { campaignId: string; productId: string; spendMinor: number }[] = [];
  let unattributedMinor = 0;
  let unlinkedCampaigns = 0;
  for (const c of campaigns) {
    if (c.spendMinor === 0) continue;
    const products = [...new Set(c.productIds)];
    if (!products.length) {
      unattributedMinor += c.spendMinor;
      unlinkedCampaigns++;
      continue;
    }
    const parts = allocateMinor(c.spendMinor, products.map((p) => Math.max(0, weightOf(p))));
    products.forEach((p, k) => {
      byProduct.set(p, (byProduct.get(p) ?? 0) + parts[k]!);
      byCampaignProduct.push({ campaignId: c.campaignId, productId: p, spendMinor: parts[k]! });
    });
  }
  return { byProduct, byCampaignProduct, unattributedMinor, unlinkedCampaigns };
}

export interface ProductProfit {
  grossMarginMinor: number;
  profitMinor: number;
  roas: number | null;
  roi: number | null;
  /** Traffic light on ROI, only for products with ad spend ("none" otherwise). */
  light: TrafficLight;
}

export function productProfit(i: { netRevenueMinor: number; cogsMinor: number; adSpendMinor: number }, thresholds: { roiGood: number; roiMedium: number }): ProductProfit {
  const grossMarginMinor = i.netRevenueMinor - i.cogsMinor;
  const profitMinor = grossMarginMinor - i.adSpendMinor;
  const roi = safeDiv(profitMinor, i.adSpendMinor);
  return { grossMarginMinor, profitMinor, roas: safeDiv(i.netRevenueMinor, i.adSpendMinor), roi, light: i.adSpendMinor > 0 ? trafficLight({ spendMinor: i.adSpendMinor, roi, profitMinor }, thresholds) : "none" };
}

export type ProductStockAction = "pause_ads" | "reorder" | "last_units" | "clear_excess" | "scale_ads" | "ok" | "no_data";

export interface ProductStockActionInput {
  available: number;
  incoming: number;
  /** Days of cover of available + incoming at the recent sales velocity; null without recent sales. */
  coverDays: number | null;
  risk: StockRisk;
  suggestedReorder: number;
  repurchasable: boolean;
  adSpendMinor: number;
  light: TrafficLight;
  /** Cover above which stock is excess (tenant setting `excessCoverDays`). */
  excessCoverDays: number;
}

/**
 * What to do with a product's stock given sales, ads and supply. Running out wins over
 * performance: ads on a product with nothing to sell are paused, a running-out product that can
 * be bought again is reordered. Excess cover suggests clearing stock; a healthy product with
 * profitable ads can take more spend.
 */
export function productStockAction(i: ProductStockActionInput): { action: ProductStockAction; reorderUnits: number } {
  const stock = Math.max(0, i.available) + Math.max(0, i.incoming);
  if (stock === 0 && i.adSpendMinor > 0) return { action: "pause_ads", reorderUnits: i.repurchasable ? i.suggestedReorder : 0 };
  if (i.risk === "critical" || i.risk === "warning") {
    if (i.repurchasable && i.suggestedReorder > 0) return { action: "reorder", reorderUnits: i.suggestedReorder };
    if (!i.repurchasable) return { action: i.risk === "critical" && i.adSpendMinor > 0 ? "pause_ads" : "last_units", reorderUnits: 0 };
  }
  if (stock > 0 && (i.coverDays === null ? i.risk === "no_sales" : i.coverDays > i.excessCoverDays)) return { action: "clear_excess", reorderUnits: 0 };
  if (i.light === "good" && i.risk === "ok") return { action: "scale_ads", reorderUnits: 0 };
  if (stock === 0) return { action: "no_data", reorderUnits: 0 };
  return { action: "ok", reorderUnits: 0 };
}
