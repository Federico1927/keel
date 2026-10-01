import type { CodSettings, RiskTier } from "./settings";

export interface RecipientShipment {
  outcome: "delivered" | "returned";
  at: Date;
}

export interface RecipientProfile {
  ordersTotal: number;
  ordersDelivered: number;
  ordersReturned: number;
  weightedReturns: number;
  consecutiveDeliveries: number;
  lastReturnAt: Date | null;
  lastDeliveryAt: Date | null;
}

/** Identity key for risk: phone first, email as fallback, never the name. */
export function recipientKey(phoneE164: string | null | undefined, emailNormalized: string | null | undefined): string | null {
  if (phoneE164 && phoneE164.replace(/\D/g, "").length >= 8) return phoneE164;
  if (emailNormalized) return `email:${emailNormalized}`;
  return null;
}

/** Aggregates shipments with a known outcome; returns are weighted by recency and floored. */
export function buildRecipientProfile(shipments: RecipientShipment[], settings: CodSettings, now = new Date()): RecipientProfile {
  const sorted = [...shipments].sort((a, b) => a.at.getTime() - b.at.getTime());
  const recentCutoff = new Date(now.getTime() - settings.risk.recentMonths * 30.4375 * 864e5);
  const returned = sorted.filter((s) => s.outcome === "returned");
  const delivered = sorted.filter((s) => s.outcome === "delivered");
  const weighted = Math.floor(returned.reduce((s, r) => s + (r.at >= recentCutoff ? settings.risk.recentWeight : settings.risk.oldWeight), 0));
  const lastReturn = returned.at(-1)?.at ?? null;
  const consecutive = lastReturn ? delivered.filter((d) => d.at > lastReturn).length : delivered.length;
  return { ordersTotal: sorted.length, ordersDelivered: delivered.length, ordersReturned: returned.length, weightedReturns: weighted, consecutiveDeliveries: consecutive, lastReturnAt: lastReturn, lastDeliveryAt: delivered.at(-1)?.at ?? null };
}

/** Tier from weighted returns with one-step redemption after enough consecutive deliveries; overrides win. */
export function classifyRecipient(p: RecipientProfile, settings: CodSettings, override: "force_clean" | "force_blacklist" | null = null): { tier: RiskTier; redeemed: boolean } {
  if (override === "force_blacklist") return { tier: "blacklisted", redeemed: false };
  if (override === "force_clean") return { tier: "clean", redeemed: false };
  const r = settings.risk;
  let level = p.weightedReturns >= r.blacklistMinReturns ? 3 : p.weightedReturns >= r.highRiskMinReturns ? 2 : p.weightedReturns >= r.watchMinReturns ? 1 : 0;
  const needed = Math.max(r.redemptionConsecutiveDeliveries, p.weightedReturns * r.redemptionDeliveriesPerReturn);
  let redeemed = false;
  if (level > 0 && p.consecutiveDeliveries >= needed) {
    level -= 1;
    redeemed = true;
  }
  return { tier: (["clean", "watch", "high_risk", "blacklisted"] as const)[level]!, redeemed };
}

/** Advice only: the UI renders text, never acts. */
export function suggestBlacklist(tier: RiskTier, override: string | null): boolean {
  return tier === "blacklisted" && override !== "force_blacklist";
}
