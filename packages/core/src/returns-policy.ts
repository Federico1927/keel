import { z } from "zod";
import { RETURN_RESOLUTIONS } from "./domain";

/**
 * Return policy of a tenant, beyond the single window of the settings:
 * - windows by shipping country, product type or product tag (the longest matching window wins
 *   for a line, so a "holiday 60 days" tag extends the default);
 * - exclusions by product type, SKU prefix, title fragment or product tag, and final sale
 *   (lines bought at or above a discount);
 * - a per-customer limit of returns in a period;
 * - thresholds of the customer return risk;
 * - automations run when a return is created or received.
 * Everything here is pure: the services feed facts in and apply the decisions.
 */

const list = z.array(z.string().trim().min(1).max(80)).max(100).default([]);

export const returnWindowRuleSchema = z.object({
  /** Empty lists match everything. All non-empty lists must match. */
  countries: z.array(z.string().length(2)).max(60).default([]),
  productTypes: list,
  tags: list,
  days: z.number().int().min(0).max(365),
});
export type ReturnWindowRule = z.infer<typeof returnWindowRuleSchema>;

export const RETURN_AUTOMATION_ACTIONS = ["approve", "reject", "flag", "set_fault", "returnless"] as const;
export type ReturnAutomationAction = (typeof RETURN_AUTOMATION_ACTIONS)[number];

export const returnAutomationSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(80),
  active: z.boolean().default(true),
  trigger: z.enum(["created"]).default("created"),
  conditions: z
    .object({
      /** Return value at or below this amount. */
      maxAmountMinor: z.number().int().min(0).nullable().default(null),
      minAmountMinor: z.number().int().min(0).nullable().default(null),
      reasonCodes: list,
      resolutions: z.array(z.enum(RETURN_RESOLUTIONS)).default([]),
      sources: z.array(z.enum(["staff", "portal", "platform"])).default([]),
      productTypes: list,
      /** Customer risk at most this level (none < watch < high). */
      maxRisk: z.enum(["none", "watch", "high"]).nullable().default(null),
      /** Customer risk at least this level. */
      minRisk: z.enum(["none", "watch", "high"]).nullable().default(null),
      firstReturnOnly: z.boolean().default(false),
    })
    .default({ maxAmountMinor: null, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: [], productTypes: [], maxRisk: null, minRisk: null, firstReturnOnly: false }),
  action: z.enum(RETURN_AUTOMATION_ACTIONS),
  /** For `set_fault`. */
  fault: z.enum(["merchant", "customer", "undetermined"]).nullable().default(null),
  /** Note written on the return (reject reason, review hint). */
  note: z.string().max(300).nullable().default(null),
});
export type ReturnAutomation = z.infer<typeof returnAutomationSchema>;

function hasCondition(a: ReturnAutomation): boolean {
  const c = a.conditions;
  return c.maxAmountMinor !== null || c.minAmountMinor !== null || c.reasonCodes.length > 0 || c.resolutions.length > 0 || c.sources.length > 0 || c.productTypes.length > 0 || c.maxRisk !== null || c.minRisk !== null || c.firstReturnOnly;
}

export const returnPolicySchema = z.object({
  windows: z.array(returnWindowRuleSchema).max(30).default([]),
  exclusions: z.object({ productTypes: list, skuPrefixes: list, titleContains: list, tags: list }).default({ productTypes: [], skuPrefixes: [], titleContains: [], tags: [] }),
  /** Lines discounted by at least this share (basis points) are final sale; null = no rule. */
  finalSaleDiscountBps: z.number().int().min(1).max(10000).nullable().default(null),
  /** At most `count` returns per customer in `days`; null = no limit. */
  customerLimit: z.object({ count: z.number().int().min(1).max(100), days: z.number().int().min(1).max(730) }).nullable().default(null),
  risk: z
    .object({
      /** Window of the customer history used for the risk. */
      days: z.number().int().min(30).max(1095).default(365),
      watchRateBps: z.number().int().min(1).max(10000).default(3000),
      highRateBps: z.number().int().min(1).max(10000).default(5000),
      minReturns: z.number().int().min(1).max(50).default(3),
      /** Returns opened this soon after delivery, with the customer at fault, look like "wear and return". */
      quickReturnDays: z.number().int().min(1).max(60).default(3),
      highValueMinor: z.number().int().min(0).default(50000),
    })
    .default({ days: 365, watchRateBps: 3000, highRateBps: 5000, minReturns: 3, quickReturnDays: 3, highValueMinor: 50000 }),
  automations: z
    .array(returnAutomationSchema)
    .max(30)
    .default([])
    // rejecting or refunding every return by accident is too costly: these two need at least one condition
    .refine((list) => list.every((a) => !(a.action === "reject" || a.action === "returnless") || hasCondition(a)), { message: "reject_and_returnless_need_a_condition" }),
});
export type ReturnPolicy = z.infer<typeof returnPolicySchema>;

export function parseReturnPolicy(raw: unknown): ReturnPolicy {
  const r = returnPolicySchema.safeParse(raw ?? {});
  return r.success ? r.data : returnPolicySchema.parse({});
}

/* ---------- per-line eligibility ---------- */

export interface PolicyLine {
  id: string;
  productType: string | null;
  sku: string | null;
  title: string;
  tags: readonly string[];
  /** Share of the list price taken off (line discount, or compare-at price), basis points. */
  discountBps: number;
}

export type LineBlock = "excluded_type" | "excluded_sku" | "excluded_title" | "excluded_tag" | "final_sale";

const lc = (s: string) => s.trim().toLowerCase();

/** Why a line cannot be returned under the policy (null = it can). */
export function lineBlock(line: PolicyLine, policy: ReturnPolicy, legacyExcludedTypes: readonly string[] = []): LineBlock | null {
  const ex = policy.exclusions;
  const types = new Set([...ex.productTypes, ...legacyExcludedTypes].map(lc));
  if (line.productType && types.has(lc(line.productType))) return "excluded_type";
  if (line.sku && ex.skuPrefixes.some((p) => line.sku!.toUpperCase().startsWith(p.toUpperCase()))) return "excluded_sku";
  if (ex.titleContains.some((f) => lc(line.title).includes(lc(f)))) return "excluded_title";
  const tags = new Set(line.tags.map(lc));
  if (ex.tags.some((t) => tags.has(lc(t)))) return "excluded_tag";
  if (policy.finalSaleDiscountBps !== null && line.discountBps >= policy.finalSaleDiscountBps) return "final_sale";
  return null;
}

/** Return window for a line: the longest matching rule (which replaces the default, also when shorter), else the default. */
export function lineWindowDays(line: Pick<PolicyLine, "productType" | "tags">, country: string | null, policy: ReturnPolicy, defaultDays: number): number {
  const tags = new Set(line.tags.map(lc));
  const matches = policy.windows.filter(
    (w) =>
      (!w.countries.length || (country !== null && w.countries.map((c) => c.toUpperCase()).includes(country.toUpperCase()))) &&
      (!w.productTypes.length || (line.productType !== null && w.productTypes.map(lc).includes(lc(line.productType)))) &&
      (!w.tags.length || w.tags.some((t) => tags.has(lc(t)))),
  );
  return matches.length ? Math.max(...matches.map((m) => m.days)) : defaultDays;
}

/** Customer limit: returns opened by the customer in the period, against the policy. */
export function customerLimitReached(policy: ReturnPolicy, recentReturnDates: readonly Date[], now: Date): boolean {
  if (!policy.customerLimit) return false;
  const since = now.getTime() - policy.customerLimit.days * 864e5;
  return recentReturnDates.filter((d) => d.getTime() >= since).length >= policy.customerLimit.count;
}

/* ---------- customer return risk ---------- */

export interface CustomerReturnStats {
  ordersCount: number;
  itemsBought: number;
  itemsReturned: number;
  returnsCount: number;
  returnedValueMinor: number;
  /** Returns with the customer at fault opened within `quickReturnDays` of delivery. */
  quickCustomerFaultReturns: number;
}
export type RiskLevel = "none" | "watch" | "high";
export const RETURN_RISK_ORDER: Record<RiskLevel, number> = { none: 0, watch: 1, high: 2 };

/** Explained risk: serial returner by rate, "wear and return" pattern, high returned value. Never an automatic block on its own. */
export function customerReturnRisk(s: CustomerReturnStats, r: ReturnPolicy["risk"]): { level: RiskLevel; rateBps: number; reasons: string[] } {
  const rateBps = s.itemsBought > 0 ? Math.round((s.itemsReturned / s.itemsBought) * 10000) : 0;
  const reasons: string[] = [];
  let level: RiskLevel = "none";
  const raise = (l: RiskLevel) => {
    if (RETURN_RISK_ORDER[l] > RETURN_RISK_ORDER[level]) level = l;
  };
  if (s.returnsCount >= r.minReturns && rateBps >= r.highRateBps) {
    reasons.push("serial_returner");
    raise("high");
  } else if (s.returnsCount >= r.minReturns && rateBps >= r.watchRateBps) {
    reasons.push("frequent_returner");
    raise("watch");
  }
  if (s.quickCustomerFaultReturns >= 2) {
    reasons.push("wear_and_return");
    raise(s.quickCustomerFaultReturns >= 3 ? "high" : "watch");
  }
  if (r.highValueMinor > 0 && s.returnedValueMinor >= r.highValueMinor && s.returnsCount >= 2) {
    reasons.push("high_returned_value");
    raise("watch");
  }
  return { level, rateBps, reasons };
}

/* ---------- automations ---------- */

export interface ReturnFacts {
  amountMinor: number;
  reasonCode: string;
  resolution: string;
  source: string;
  productTypes: readonly string[];
  risk: RiskLevel;
  previousReturns: number;
}

export function automationMatches(a: ReturnAutomation, f: ReturnFacts): boolean {
  const c = a.conditions;
  if (!a.active) return false;
  if (c.maxAmountMinor !== null && f.amountMinor > c.maxAmountMinor) return false;
  if (c.minAmountMinor !== null && f.amountMinor < c.minAmountMinor) return false;
  if (c.reasonCodes.length && !c.reasonCodes.includes(f.reasonCode)) return false;
  if (c.resolutions.length && !(c.resolutions as readonly string[]).includes(f.resolution)) return false;
  if (c.sources.length && !(c.sources as readonly string[]).includes(f.source)) return false;
  if (c.productTypes.length && !f.productTypes.some((t) => c.productTypes.map(lc).includes(lc(t)))) return false;
  if (c.maxRisk !== null && RETURN_RISK_ORDER[f.risk] > RETURN_RISK_ORDER[c.maxRisk]) return false;
  if (c.minRisk !== null && RETURN_RISK_ORDER[f.risk] < RETURN_RISK_ORDER[c.minRisk]) return false;
  if (c.firstReturnOnly && f.previousReturns > 0) return false;
  return true;
}

/**
 * Automations to apply, in list order. `flag` and `set_fault` accumulate; the first decision
 * (approve, reject, returnless) wins and stops the evaluation.
 */
export function selectAutomations(rules: readonly ReturnAutomation[], f: ReturnFacts): ReturnAutomation[] {
  const out: ReturnAutomation[] = [];
  for (const r of rules) {
    if (!automationMatches(r, f)) continue;
    out.push(r);
    if (r.action === "approve" || r.action === "reject" || r.action === "returnless") break;
  }
  return out;
}
