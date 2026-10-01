import type { CodSettings, RiskTier, ScoreFactorKey } from "./settings";

export type Severity = "positive" | "neutral" | "warning" | "critical" | "info";

export interface ScoreFactor {
  key: ScoreFactorKey;
  raw: number | null;
  weight: number;
  severity: Severity;
  /** False for informational factors that are listed but do not enter the mean. */
  contributes: boolean;
  detail: Record<string, unknown>;
}

export interface OutcomeRecord {
  outcome: "delivered" | "refused" | "cancelled" | "other";
  ageDays: number;
}

export interface AddressInput {
  phone: string | null;
  address1: string | null;
  zip: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
}

export interface ScoreInput {
  /** Past orders of the matched customer with outcomes; null when the customer is unknown. */
  customerOrders: OutcomeRecord[] | null;
  /** Prepaid (non-COD) orders the customer completed: a weak positive signal. */
  prepaidDelivered: number;
  attempts: number;
  hoursSinceOrder: number;
  closed: boolean;
  lines: { productId: string | null; variantId: string | null; quantity: number }[];
  address: AddressInput | null;
  similarOrders: { sample: number; delivered: number } | null;
  totalMinor: number;
  aovMinor: number | null;
  localHour: number;
  recentCancellations: { count: number; sharesProduct: boolean };
  duplicates: "none" | "same_variant" | "same_product";
  riskTier: RiskTier | null;
}

export interface ScoreResult {
  base: number;
  score: number;
  factors: ScoreFactor[];
  riskTier: RiskTier | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Exponentially decayed delivery ratio of a customer; null when too few orders carry an outcome. */
export function customerDeliveryScore(orders: OutcomeRecord[], settings: Pick<CodSettings, "customerHistoryHalfLifeDays" | "customerHistoryMinOrders">): number | null {
  const scored = orders.filter((o) => o.outcome !== "other");
  if (scored.length < settings.customerHistoryMinOrders) return null;
  const w = (o: OutcomeRecord) => Math.exp((-Math.LN2 * Math.max(0, o.ageDays)) / settings.customerHistoryHalfLifeDays);
  const delivered = scored.filter((o) => o.outcome === "delivered").reduce((s, o) => s + w(o), 0);
  const total = scored.reduce((s, o) => s + w(o), 0);
  return total > 0 ? clamp((100 * delivered) / total) : 60;
}

/** Generic address checks plus per-country postal code validators; unknown countries only get the generic checks. */
export function addressQuality(a: AddressInput): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const digits = (a.phone ?? "").replace(/\D/g, "");
  if (digits.length < 8) problems.push("phone");
  if (!a.address1 || a.address1.trim().length < 5) problems.push("address1");
  if (!a.zip) problems.push("zip");
  if (!a.city || /\d{4,}/.test(a.city)) problems.push("city");
  const country = (a.country ?? "").toUpperCase();
  const zip = (a.zip ?? "").trim();
  const zipRules: Record<string, RegExp> = { IT: /^\d{5}$/, ES: /^\d{5}$/, FR: /^\d{5}$/, DE: /^\d{5}$/, US: /^\d{5}(-\d{4})?$/, PT: /^\d{4}-\d{3}$/, NL: /^\d{4}\s?[A-Z]{2}$/i, GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, CH: /^\d{4}$/, AT: /^\d{4}$/, BE: /^\d{4}$/ };
  if (zip && zipRules[country] && !zipRules[country]!.test(zip)) problems.push("zip_format");
  if (["IT", "ES"].includes(country) && !a.province) problems.push("province");
  return { ok: problems.length === 0, problems };
}

/** Penalty applied after the weighted mean: never raises a score, caps it per tier. */
export function penalizedScore(base: number, tier: RiskTier | null, settings: CodSettings): number {
  if (!tier || tier === "clean") return base;
  const p = settings.risk.penalties[tier];
  return clamp(Math.min(Math.round(base * p.multiplier), p.cap));
}

/**
 * Delivery score 0–100 as a weighted mean of the factors that fire, explained factor by factor.
 * Informational factors are returned with `contributes: false`; the risk tier is applied at the end.
 */
export function computeDeliveryScore(i: ScoreInput, settings: CodSettings): ScoreResult {
  const w = settings.weights;
  const factors: ScoreFactor[] = [];
  const push = (key: ScoreFactorKey, raw: number | null, severity: Severity, contributes: boolean, detail: Record<string, unknown> = {}) => factors.push({ key, raw, weight: w[key], severity, contributes: contributes && w[key] > 0 && raw !== null, detail });

  // 1. customer history
  const cs = i.customerOrders ? customerDeliveryScore(i.customerOrders, settings) : null;
  if (cs === null) push("customer_history", null, "info", false, { reason: i.customerOrders ? "too_few_orders" : "unknown_customer", orders: i.customerOrders?.length ?? 0 });
  else push("customer_history", cs, cs >= 75 ? "positive" : cs >= 40 ? "neutral" : "critical", true, { orders: i.customerOrders!.length, delivered: i.customerOrders!.filter((o) => o.outcome === "delivered").length, refused: i.customerOrders!.filter((o) => o.outcome === "refused").length, cancelled: i.customerOrders!.filter((o) => o.outcome === "cancelled").length });
  // prepaid history (weak positive)
  if (i.prepaidDelivered > 0) push("prepaid_history", Math.min(95, 70 + 5 * i.prepaidDelivered), "positive", true, { prepaidDelivered: i.prepaidDelivered });
  // 2. attempts
  if (i.attempts > 0) push("cod_attempts", Math.max(20, 80 - 20 * i.attempts), i.attempts >= settings.unreachableAfterAttempts ? "warning" : "neutral", true, { attempts: i.attempts });
  // 3. time elapsed
  if (!i.closed) {
    const days = i.hoursSinceOrder / 24;
    push("time_elapsed", Math.max(20, Math.round(90 - 15 * days)), i.hoursSinceOrder > settings.timeElapsedWarnHours ? "warning" : "neutral", true, { hours: Math.round(i.hoursSinceOrder) });
  }
  // 4. cart: same product in several variants / big quantities
  const byProduct = new Map<string, { variants: Set<string>; qty: number }>();
  for (const l of i.lines) {
    if (!l.productId) continue;
    const e = byProduct.get(l.productId) ?? { variants: new Set<string>(), qty: 0 };
    if (l.variantId) e.variants.add(l.variantId);
    e.qty += l.quantity;
    byProduct.set(l.productId, e);
  }
  const multiVariant = [...byProduct.values()].filter((p) => p.variants.size >= 2).length;
  if (multiVariant > 0) push("cart_variants", 30, "warning", true, { products: multiVariant });
  const bigQty = [...byProduct.values()].filter((p) => p.qty >= 3).length;
  if (bigQty > 0) push("cart_quantity", 45, "neutral", true, { products: bigQty });
  // 5. address
  if (i.address) {
    const q = addressQuality(i.address);
    push("address_quality", q.ok ? 85 : 15, q.ok ? "positive" : "critical", true, { problems: q.problems });
  }
  // 6. similar orders (same zip, same payment method, known outcome)
  if (i.similarOrders && i.similarOrders.sample >= settings.similarOrdersMinSample) {
    const rate = i.similarOrders.delivered / i.similarOrders.sample;
    push("similar_orders", clamp(100 * rate), rate >= 0.75 ? "positive" : rate >= 0.55 ? "neutral" : "warning", true, { sample: i.similarOrders.sample, delivered: i.similarOrders.delivered });
  } else push("similar_orders", null, "info", false, { sample: i.similarOrders?.sample ?? 0 });
  // 7. order value vs tenant AOV
  if (i.aovMinor && i.totalMinor > settings.orderValueMultiple * i.aovMinor) push("order_value", 40, "warning", true, { totalMinor: i.totalMinor, aovMinor: i.aovMinor });
  // 8. night order
  const night = settings.nightFromHour > settings.nightToHour ? i.localHour >= settings.nightFromHour || i.localHour < settings.nightToHour : i.localHour >= settings.nightFromHour && i.localHour < settings.nightToHour;
  if (night) push("night_order", 35, "neutral", true, { localHour: i.localHour });
  // 9. recent cancellations of the same customer
  if (i.recentCancellations.count > 0) {
    const raw = Math.max(5, 60 - 15 * i.recentCancellations.count - (i.recentCancellations.sharesProduct ? 15 : 0));
    push("recent_cancellations", raw, raw <= 20 ? "critical" : raw <= 40 ? "warning" : "neutral", true, i.recentCancellations);
  } else push("recent_cancellations", null, "positive", false, { count: 0 });
  // 10. duplicates
  push("duplicate_orders", i.duplicates === "none" ? 100 : i.duplicates === "same_variant" ? 15 : 40, i.duplicates === "none" ? "positive" : i.duplicates === "same_variant" ? "critical" : "warning", true, { match: i.duplicates });

  let sum = 0;
  let wsum = 0;
  for (const f of factors) if (f.contributes && f.raw !== null) {
    sum += f.raw * f.weight;
    wsum += f.weight;
  }
  const base = wsum > 0 ? clamp(sum / wsum) : 50;
  return { base, score: penalizedScore(base, i.riskTier, settings), factors, riskTier: i.riskTier };
}

export function scoreBand(score: number): "likely" | "uncertain" | "unlikely" {
  return score >= 75 ? "likely" : score >= 40 ? "uncertain" : "unlikely";
}
