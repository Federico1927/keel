export type DiscountType = "percentage" | "fixed_amount" | "free_shipping";

/** Unambiguous alphabet (no 0/O, 1/I/L) for human-typed codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Generates `count` distinct codes `PREFIX-XXXXXXXX`; `random` returns [0,1) so callers can inject crypto or a seeded RNG. */
export function generateUniqueCodes(prefix: string, count: number, random: () => number, length = 8, taken: Iterable<string> = []): string[] {
  const out = new Set<string>();
  const used = new Set([...taken].map((c) => c.toUpperCase()));
  const clean = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  let guard = 0;
  while (out.size < count && guard < count * 50) {
    guard++;
    let body = "";
    for (let i = 0; i < length; i++) body += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]!;
    const code = clean ? `${clean}-${body}` : body;
    if (!used.has(code)) {
      used.add(code);
      out.add(code);
    }
  }
  return [...out];
}

export interface DiscountRule {
  type: DiscountType;
  /** Percentage in basis points, or amount in minor units. */
  value: number;
  minimumAmountMinor?: number | null;
  usageLimit?: number | null;
  usedCount?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  isActive?: boolean;
}

export type DiscountState = "active" | "scheduled" | "expired" | "exhausted" | "disabled";

export function discountState(d: DiscountRule, now = new Date()): DiscountState {
  if (d.isActive === false) return "disabled";
  if (d.usageLimit && (d.usedCount ?? 0) >= d.usageLimit) return "exhausted";
  if (d.startsAt && d.startsAt.getTime() > now.getTime()) return "scheduled";
  if (d.endsAt && d.endsAt.getTime() < now.getTime()) return "expired";
  return "active";
}

/** Amount the code would take off an order; 0 with a reason when it does not apply. */
export function discountAmount(d: DiscountRule, subtotalMinor: number, shippingMinor: number, now = new Date()): { amountMinor: number; applicable: boolean; reason: "inactive" | "minimum" | null } {
  if (discountState(d, now) !== "active") return { amountMinor: 0, applicable: false, reason: "inactive" };
  if (d.minimumAmountMinor && subtotalMinor < d.minimumAmountMinor) return { amountMinor: 0, applicable: false, reason: "minimum" };
  switch (d.type) {
    case "percentage": return { amountMinor: Math.round((subtotalMinor * d.value) / 10000), applicable: true, reason: null };
    case "fixed_amount": return { amountMinor: Math.min(subtotalMinor, d.value), applicable: true, reason: null };
    case "free_shipping": return { amountMinor: shippingMinor, applicable: true, reason: null };
  }
}

export function formatDiscountValue(type: DiscountType, value: number, formatMoney: (minor: number) => string): string {
  if (type === "percentage") return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  if (type === "fixed_amount") return formatMoney(value);
  return "free shipping";
}

/* ---------- pools (issue #35) ---------- */

export type PoolCodeStatus = "available" | "assigned" | "redeemed";
export const POOL_CODE_STATUSES: readonly PoolCodeStatus[] = ["available", "assigned", "redeemed"];

/** A pool code is redeemed once an order used it, assigned once handed to a customer or a campaign, available otherwise. Being active on the platform is a separate flag. */
export function poolCodeStatus(c: { redeemedOrderId?: string | null; usedCount?: number; assignedCustomerId?: string | null; assignedCampaignId?: string | null }): PoolCodeStatus {
  if (c.redeemedOrderId || (c.usedCount ?? 0) > 0) return "redeemed";
  if (c.assignedCustomerId || c.assignedCampaignId) return "assigned";
  return "available";
}

/** Codes to generate so the pool has `target` codes ready to hand out (available and active); never negative, capped per run. */
export function poolTopUpCount(availableActive: number, target: number, maxPerRun = 10_000): number {
  return Math.max(0, Math.min(maxPerRun, Math.round(target) - availableActive));
}
