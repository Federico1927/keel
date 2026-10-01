import { z } from "zod";
import { MAX_SEGMENT_CONDITIONS, MAX_SEGMENT_DEPTH } from "@keel/config";
import { CHURN_RISKS } from "./predictions";

/**
 * Segment rules: nested AND/OR groups of typed conditions over a customer profile.
 * The field catalog is the only place that knows what a field means; the SQL compiler in
 * services and the in-memory evaluator below both read it, so they cannot drift apart.
 */
export type SegmentFieldType = "number" | "days" | "boolean" | "enum" | "text_array" | "uuid_array";
export type SegmentOp = "gte" | "lte" | "gt" | "lt" | "eq" | "between" | "is_null" | "not_null" | "in" | "not_in" | "any" | "none" | "all";

export const OPS_BY_TYPE: Record<SegmentFieldType, readonly SegmentOp[]> = {
  number: ["gte", "lte", "gt", "lt", "eq", "between"],
  days: ["gte", "lte", "gt", "lt", "eq", "between", "is_null", "not_null"],
  boolean: ["eq"],
  enum: ["in", "not_in"],
  text_array: ["any", "none", "all"],
  uuid_array: ["any", "none", "all"],
};

export interface SegmentFieldDef {
  type: SegmentFieldType;
  /** Fixed value list for enums; `dynamic` when the UI loads values from the tenant data. */
  values?: readonly string[] | "dynamic";
  /** Money fields are entered in major units in the UI and stored in minor units. */
  money?: boolean;
  group: "orders" | "value" | "recency" | "profile" | "products" | "rfm" | "predictions" | "sampling";
}

export const RFM_RECENCY_BANDS = ["r0_90", "r91_180", "r181_365", "r366_730", "r730_plus"] as const;
export const RFM_FREQUENCY_BANDS = ["f1", "f2", "f3_4", "f5_plus"] as const;
export const RFM_TIERS = ["champions", "loyal", "promising", "at_risk", "new", "one_time", "dormant", "lost"] as const;
export type RfmRecencyBand = (typeof RFM_RECENCY_BANDS)[number];
export type RfmFrequencyBand = (typeof RFM_FREQUENCY_BANDS)[number];
export type RfmTier = (typeof RFM_TIERS)[number];

/** Core field catalog. Add-ons may register extra fields through `registerSegmentFields`. */
export const SEGMENT_FIELDS: Record<string, SegmentFieldDef> = {
  orders_count: { type: "number", group: "orders" },
  cancelled_count: { type: "number", group: "orders" },
  returns_count: { type: "number", group: "orders" },
  total_spent: { type: "number", money: true, group: "value" },
  aov: { type: "number", money: true, group: "value" },
  days_since_last_order: { type: "days", group: "recency" },
  days_since_first_order: { type: "days", group: "recency" },
  accepts_marketing: { type: "boolean", group: "profile" },
  country: { type: "enum", values: "dynamic", group: "profile" },
  tags: { type: "text_array", group: "profile" },
  payment_methods: { type: "text_array", group: "orders" },
  bought_product: { type: "uuid_array", group: "products" },
  bought_product_type: { type: "text_array", group: "products" },
  rfm_recency: { type: "enum", values: RFM_RECENCY_BANDS, group: "rfm" },
  rfm_frequency: { type: "enum", values: RFM_FREQUENCY_BANDS, group: "rfm" },
  rfm_tier: { type: "enum", values: RFM_TIERS, group: "rfm" },
  churn_risk: { type: "enum", values: CHURN_RISKS, group: "predictions" },
  p_alive: { type: "number", group: "predictions" },
  predicted_value: { type: "number", money: true, group: "predictions" },
  days_to_next_order: { type: "days", group: "predictions" },
  random_pct: { type: "number", group: "sampling" },
};

const extraFields: Record<string, SegmentFieldDef> = {};
/** Extension hook for add-ons (e.g. a COD risk tier); core never calls it. */
export function registerSegmentFields(fields: Record<string, SegmentFieldDef>): void {
  Object.assign(extraFields, fields);
}
export function segmentFieldCatalog(): Record<string, SegmentFieldDef> {
  return { ...SEGMENT_FIELDS, ...extraFields };
}

export interface SegmentLeaf {
  field: string;
  op: SegmentOp;
  value?: unknown;
}
export interface SegmentGroup {
  match: "all" | "any";
  conditions: (SegmentLeaf | SegmentGroup)[];
}
export type SegmentNode = SegmentLeaf | SegmentGroup;

export function isGroup(n: SegmentNode): n is SegmentGroup {
  return typeof n === "object" && n !== null && "conditions" in n;
}

const leafSchema = z.object({ field: z.string().min(1).max(64), op: z.enum(["gte", "lte", "gt", "lt", "eq", "between", "is_null", "not_null", "in", "not_in", "any", "none", "all"]), value: z.unknown().optional() });
const groupSchema: z.ZodType<SegmentGroup> = z.lazy(() => z.object({ match: z.enum(["all", "any"]), conditions: z.array(z.union([leafSchema, groupSchema])) }));
export const segmentRulesSchema = groupSchema;

export function countLeaves(node: SegmentNode): number {
  return isGroup(node) ? node.conditions.reduce((s, c) => s + countLeaves(c), 0) : 1;
}
export function depthOf(node: SegmentNode, current = 1): number {
  return isGroup(node) ? Math.max(current, ...node.conditions.map((c) => depthOf(c, current + 1))) : current - 1;
}

export interface RuleError {
  path: string;
  code: "unknown_field" | "bad_op" | "bad_value" | "empty_group" | "too_deep" | "too_many" | "invalid_shape";
}

/** Structural + semantic validation; returns [] when the rules can be compiled safely. */
export function validateSegmentRules(input: unknown): { rules: SegmentGroup | null; errors: RuleError[] } {
  const parsed = segmentRulesSchema.safeParse(input);
  if (!parsed.success) return { rules: null, errors: [{ path: "", code: "invalid_shape" }] };
  const rules = parsed.data;
  const errors: RuleError[] = [];
  if (countLeaves(rules) > MAX_SEGMENT_CONDITIONS) errors.push({ path: "", code: "too_many" });
  if (depthOf(rules) > MAX_SEGMENT_DEPTH) errors.push({ path: "", code: "too_deep" });
  const catalog = segmentFieldCatalog();
  const walk = (g: SegmentGroup, path: string) => {
    if (g.conditions.length === 0) errors.push({ path, code: "empty_group" });
    g.conditions.forEach((c, i) => {
      const p = path ? `${path}.${i}` : String(i);
      if (isGroup(c)) return walk(c, p);
      const def = catalog[c.field];
      if (!def) return errors.push({ path: p, code: "unknown_field" });
      if (!OPS_BY_TYPE[def.type].includes(c.op)) return errors.push({ path: p, code: "bad_op" });
      if (!valueOk(def, c)) errors.push({ path: p, code: "bad_value" });
    });
  };
  walk(rules, "");
  return { rules: errors.length ? null : rules, errors };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function valueOk(def: SegmentFieldDef, leaf: SegmentLeaf): boolean {
  const v = leaf.value;
  if (leaf.op === "is_null" || leaf.op === "not_null") return true;
  if (leaf.op === "between") return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  switch (def.type) {
    case "number":
    case "days":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "enum":
      return Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every((x) => typeof x === "string" && x.length <= 100) && (def.values === "dynamic" || !def.values || v.every((x) => (def.values as readonly string[]).includes(x as string)));
    case "text_array":
      return Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every((x) => typeof x === "string" && x.length <= 200);
    case "uuid_array":
      return Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every((x) => typeof x === "string" && UUID.test(x));
  }
}

/** The customer profile every field reads from; built by services from orders and the customer row. */
export interface CustomerProfile {
  customerId: string;
  ordersCount: number;
  cancelledCount: number;
  returnsCount: number;
  totalSpentMinor: number;
  aovMinor: number | null;
  daysSinceLastOrder: number | null;
  daysSinceFirstOrder: number | null;
  acceptsMarketing: boolean;
  country: string | null;
  tags: string[];
  paymentMethods: string[];
  productIds: string[];
  productTypes: string[];
  randomPct: number;
  /** Predictions (null until the model has run for this customer). P(active) in percent, 0–100. */
  churnRisk?: string | null;
  pAlivePct?: number | null;
  predictedValueMinor?: number | null;
  /** Days until the expected next order; negative when overdue. */
  daysToNextOrder?: number | null;
}

export function profileValue(p: CustomerProfile, field: string, now: Date): unknown {
  switch (field) {
    case "orders_count": return p.ordersCount;
    case "cancelled_count": return p.cancelledCount;
    case "returns_count": return p.returnsCount;
    case "total_spent": return p.totalSpentMinor;
    case "aov": return p.aovMinor;
    case "days_since_last_order": return p.daysSinceLastOrder;
    case "days_since_first_order": return p.daysSinceFirstOrder;
    case "accepts_marketing": return p.acceptsMarketing;
    case "country": return p.country;
    case "tags": return p.tags;
    case "payment_methods": return p.paymentMethods;
    case "bought_product": return p.productIds;
    case "bought_product_type": return p.productTypes;
    case "rfm_recency": return rfmRecencyBand(p.daysSinceLastOrder);
    case "rfm_frequency": return rfmFrequencyBand(p.ordersCount);
    case "rfm_tier": return rfmTier(p.ordersCount, p.daysSinceLastOrder);
    case "churn_risk": return p.churnRisk ?? null;
    case "p_alive": return p.pAlivePct ?? null;
    case "predicted_value": return p.predictedValueMinor ?? null;
    case "days_to_next_order": return p.daysToNextOrder ?? null;
    case "random_pct": return p.randomPct;
    default: { void now; return undefined; }
  }
}

/** In-memory evaluation with the same semantics as the SQL compiler (used by tests and previews). */
export function evaluateRules(rules: SegmentGroup, p: CustomerProfile, now = new Date()): boolean {
  const test = (n: SegmentNode): boolean => {
    if (isGroup(n)) {
      if (n.conditions.length === 0) return true;
      return n.match === "all" ? n.conditions.every(test) : n.conditions.some(test);
    }
    return evalLeaf(n, profileValue(p, n.field, now));
  };
  return test(rules);
}

function evalLeaf(leaf: SegmentLeaf, actual: unknown): boolean {
  const v = leaf.value;
  switch (leaf.op) {
    case "is_null": return actual === null || actual === undefined;
    case "not_null": return actual !== null && actual !== undefined;
    case "gte": return typeof actual === "number" && actual >= (v as number);
    case "lte": return typeof actual === "number" && actual <= (v as number);
    case "gt": return typeof actual === "number" && actual > (v as number);
    case "lt": return typeof actual === "number" && actual < (v as number);
    case "eq": return typeof actual === "boolean" ? actual === Boolean(v) : actual === v;
    case "between": return typeof actual === "number" && actual >= (v as number[])[0]! && actual <= (v as number[])[1]!;
    case "in": return actual !== null && actual !== undefined && (v as string[]).includes(String(actual));
    case "not_in": return actual === null || actual === undefined || !(v as string[]).includes(String(actual));
    case "any": return Array.isArray(actual) && (v as string[]).some((x) => actual.includes(x));
    case "none": return !Array.isArray(actual) || !(v as string[]).some((x) => actual.includes(x));
    case "all": return Array.isArray(actual) && (v as string[]).every((x) => actual.includes(x));
  }
}

/* ---------- RFM ---------- */

export function rfmRecencyBand(daysSinceLastOrder: number | null): RfmRecencyBand | null {
  if (daysSinceLastOrder === null) return null;
  if (daysSinceLastOrder <= 90) return "r0_90";
  if (daysSinceLastOrder <= 180) return "r91_180";
  if (daysSinceLastOrder <= 365) return "r181_365";
  if (daysSinceLastOrder <= 730) return "r366_730";
  return "r730_plus";
}
export function rfmFrequencyBand(ordersCount: number): RfmFrequencyBand | null {
  if (ordersCount < 1) return null;
  if (ordersCount === 1) return "f1";
  if (ordersCount === 2) return "f2";
  if (ordersCount <= 4) return "f3_4";
  return "f5_plus";
}
/** Tier rules evaluated top-down (lost → dormant → champions → loyal → at risk → promising → new → one-time). */
export function rfmTier(ordersCount: number, daysSinceLastOrder: number | null): RfmTier | null {
  if (ordersCount < 1 || daysSinceLastOrder === null) return null;
  const d = daysSinceLastOrder;
  if (d > 730) return "lost";
  if (d > 365) return "dormant";
  if (ordersCount >= 5 && d <= 180) return "champions";
  if (ordersCount >= 5) return "loyal";
  if (ordersCount >= 3 && d <= 180) return "loyal";
  if (ordersCount >= 2 && d > 180) return "at_risk";
  if (ordersCount >= 2) return "promising";
  if (d <= 90) return "new";
  return "one_time";
}

export interface RfmCell {
  recency: RfmRecencyBand;
  frequency: RfmFrequencyBand;
  customers: number;
  contactable: number;
  revenueMinor: number;
  aovMinor: number | null;
}
export interface RfmMatrix {
  cells: RfmCell[];
  tiers: { tier: RfmTier; customers: number; revenueMinor: number; contactable: number }[];
  total: number;
}
export function buildRfmMatrix(profiles: Pick<CustomerProfile, "ordersCount" | "daysSinceLastOrder" | "totalSpentMinor" | "acceptsMarketing">[]): RfmMatrix {
  const cells = new Map<string, RfmCell>();
  const tiers = new Map<RfmTier, { tier: RfmTier; customers: number; revenueMinor: number; contactable: number }>();
  let total = 0;
  for (const p of profiles) {
    const r = rfmRecencyBand(p.daysSinceLastOrder);
    const f = rfmFrequencyBand(p.ordersCount);
    const tier = rfmTier(p.ordersCount, p.daysSinceLastOrder);
    if (!r || !f || !tier) continue;
    total++;
    const k = `${r}|${f}`;
    const c = cells.get(k) ?? { recency: r, frequency: f, customers: 0, contactable: 0, revenueMinor: 0, aovMinor: null };
    c.customers++;
    c.revenueMinor += p.totalSpentMinor;
    if (p.acceptsMarketing) c.contactable++;
    cells.set(k, c);
    const t = tiers.get(tier) ?? { tier, customers: 0, revenueMinor: 0, contactable: 0 };
    t.customers++;
    t.revenueMinor += p.totalSpentMinor;
    if (p.acceptsMarketing) t.contactable++;
    tiers.set(tier, t);
  }
  for (const c of cells.values()) c.aovMinor = c.customers ? Math.round(c.revenueMinor / c.customers) : null;
  return { cells: [...cells.values()], tiers: RFM_TIERS.map((t) => tiers.get(t) ?? { tier: t, customers: 0, revenueMinor: 0, contactable: 0 }), total };
}

export function rulesForRfmCell(recency: RfmRecencyBand, frequency: RfmFrequencyBand): SegmentGroup {
  return { match: "all", conditions: [{ field: "rfm_recency", op: "in", value: [recency] }, { field: "rfm_frequency", op: "in", value: [frequency] }] };
}
export function rulesForRfmTier(tier: RfmTier): SegmentGroup {
  return { match: "all", conditions: [{ field: "rfm_tier", op: "in", value: [tier] }] };
}

/* ---------- holdout ---------- */

/** FNV-1a 32-bit: deterministic, dependency-free, identical in Node, Postgres-free paths and the browser. */
export function stableBucket(key: string, buckets = 10_000): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % buckets;
}

/** Same (segment, customer, salt) always lands in the same group; re-evaluating never moves anyone. */
export function assignHoldout(segmentId: string, customerId: string, holdoutPercentage: number, salt = "holdout"): "treated" | "holdout" {
  if (holdoutPercentage <= 0) return "treated";
  return stableBucket(`${segmentId}:${customerId}:${salt}`) < holdoutPercentage * 100 ? "holdout" : "treated";
}

/* ---------- uplift statistics (library for future campaign results) ---------- */

/** Standard normal CDF, Abramowitz–Stegun 7.1.26 (abs error < 1.5e-7). */
export function normCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface TwoProportionResult {
  p1: number;
  p2: number;
  diff: number;
  z: number | null;
  pValue: number | null;
  ci95: [number, number] | null;
}
/** Two-sided two-proportion z-test: pooled SE for z, unpooled SE for the confidence interval. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): TwoProportionResult {
  if (n1 <= 0 || n2 <= 0) return { p1: 0, p2: 0, diff: 0, z: null, pValue: null, ci95: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pp = (x1 + x2) / (n1 + n2);
  const se0 = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const diff = p1 - p2;
  const z = se0 > 0 ? diff / se0 : null;
  return { p1, p2, diff, z, pValue: z === null ? null : 2 * (1 - normCdf(Math.abs(z))), ci95: [diff - 1.96 * se, diff + 1.96 * se] };
}
