import { safeDiv } from "./money";
import type { StockRisk } from "./inventory";

export type TrafficLight = "good" | "medium" | "bad" | "none";
export type CampaignAction = "ok" | "pause" | "resume" | "consider_pause" | "consider_resume" | "pause_stock" | "consider_stock";
export type RestockAdvice = "reorder" | "ok" | "unknown";

export interface CampaignMetricsInput {
  spendMinor: number;
  clicks: number;
  impressions: number;
  attributedOrders: number;
  netRevenueMinor: number;
  marginMinor: number;
}
export interface CampaignMetrics extends CampaignMetricsInput {
  profitMinor: number;
  roas: number | null;
  roi: number | null;
  cpaMinor: number | null;
  cpcMinor: number | null;
  conversionRate: number | null;
}

/** Profit counts only in-scope orders (not cancelled, not returned): callers pass margin from orderEconomics. */
export function campaignMetrics(i: CampaignMetricsInput): CampaignMetrics {
  const profit = i.marginMinor - i.spendMinor;
  return {
    ...i,
    profitMinor: profit,
    roas: safeDiv(i.netRevenueMinor, i.spendMinor),
    roi: safeDiv(profit, i.spendMinor),
    cpaMinor: i.attributedOrders ? Math.round(i.spendMinor / i.attributedOrders) : null,
    cpcMinor: i.clicks ? Math.round(i.spendMinor / i.clicks) : null,
    conversionRate: safeDiv(i.attributedOrders, i.clicks),
  };
}

export function trafficLight(m: Pick<CampaignMetrics, "spendMinor" | "roi" | "profitMinor">, thresholds: { roiGood: number; roiMedium: number }): TrafficLight {
  if (m.spendMinor <= 0) return m.profitMinor > 0 ? "medium" : "none";
  if (m.roi === null) return "none";
  if (m.roi >= thresholds.roiGood) return "good";
  if (m.roi > thresholds.roiMedium) return "medium";
  return "bad";
}

export interface RecommendationInput {
  status: "active" | "paused" | "archived" | string;
  light: TrafficLight;
  /** Any linked product can be repurchased. */
  repurchasable: boolean;
  /** Total available stock of linked products; null when no product is linked. */
  stock: number | null;
  incoming: number;
  stockThreshold: number;
  stockRisk?: StockRisk | null;
}

/**
 * Recommended action from performance × state × stock (CLAUDE.md §7.5):
 * stock below threshold with nothing incoming beats performance for an active campaign.
 */
export function recommendAction(i: RecommendationInput): { action: CampaignAction; restock: RestockAdvice; reason: string } {
  const active = i.status === "active";
  const lowStock = i.stock !== null && i.stock <= i.stockThreshold;
  let restock: RestockAdvice = "unknown";
  if (i.stock !== null) restock = lowStock && i.repurchasable && (i.light === "good" || i.light === "medium") ? "reorder" : "ok";
  if (active && lowStock && i.incoming <= 0) {
    if (!i.repurchasable || i.stock === 0) return { action: "pause_stock", restock, reason: "stock_below_threshold" };
    return { action: "consider_stock", restock, reason: "stock_below_threshold_incoming_none" };
  }
  if (active && lowStock && i.incoming > 0) return { action: "consider_stock", restock, reason: "stock_below_threshold_incoming" };
  if (!i.repurchasable && active && lowStock) return { action: "pause", restock: "ok", reason: "not_repurchasable" };
  switch (i.light) {
    case "bad":
      return { action: active ? "pause" : "ok", restock, reason: "roi_bad" };
    case "medium":
      return { action: active ? "consider_pause" : "consider_resume", restock, reason: "roi_medium" };
    case "good":
      return { action: active ? "ok" : "resume", restock, reason: "roi_good" };
    default:
      return { action: "ok", restock, reason: "no_data" };
  }
}

export interface ProductRef {
  id: string;
  title: string;
  handle: string | null;
}
export type SuggestionKind = "url" | "exact" | "prefix" | "contains" | "token";
export interface ProductSuggestion {
  productId: string;
  kind: SuggestionKind;
  confidence: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const firstToken = (s: string) => norm(s).split(" ")[0] ?? "";

/** Suggests linked products from the campaign name and the landing URLs of its ads. */
export function suggestProductsForCampaign(campaignName: string, landingUrls: readonly string[], products: readonly ProductRef[]): ProductSuggestion[] {
  const out = new Map<string, ProductSuggestion>();
  const add = (p: ProductRef, kind: SuggestionKind, confidence: number) => {
    const prev = out.get(p.id);
    if (!prev || prev.confidence < confidence) out.set(p.id, { productId: p.id, kind, confidence });
  };
  for (const url of landingUrls) {
    const m = /\/products\/([^/?#]+)/i.exec(url);
    if (!m) continue;
    const handle = decodeURIComponent(m[1]!).toLowerCase();
    for (const p of products) if (p.handle && p.handle.toLowerCase() === handle) add(p, "url", 1);
  }
  const name = norm(campaignName);
  for (const p of products) {
    const title = norm(p.title);
    if (!title) continue;
    if (name === title) add(p, "exact", 0.95);
    else if (name.length >= 6 && title.length >= 6 && (name.startsWith(title) || title.startsWith(name))) add(p, "prefix", 0.8);
    else if (title.length >= 4 && name.includes(title)) add(p, "contains", 0.7);
    else if (firstToken(title).length >= 3 && name.split(" ").includes(firstToken(title)) && title.split(" ").length === 1) add(p, "token", 0.4);
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence);
}
