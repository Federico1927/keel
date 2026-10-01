import { z } from "zod";
import { ORDER_STATUSES, type OrderStatus, type PaymentStatus, type ShipmentStatus } from "./domain";
import { PAYMENT_METHODS, type PaymentMethod } from "./tenant-settings";

/**
 * Configurable mapping from platform facts to the canonical status (CLAUDE.md §4).
 * Rules are evaluated in priority order (lowest first); the first match wins.
 * Hard facts (cancellation, refund, delivery, returns) override every rule.
 */
export const stateRuleConditionsSchema = z.object({
  tagsAny: z.array(z.string().trim().min(1)).optional(),
  tagsAll: z.array(z.string().trim().min(1)).optional(),
  tagsNone: z.array(z.string().trim().min(1)).optional(),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).optional(),
  paymentStatuses: z.array(z.enum(["pending", "paid", "partially_refunded", "refunded", "voided"])).optional(),
  /** Raw platform financial status, e.g. Shopify `authorized`, `paid`, `pending`. */
  financialStatusRaw: z.array(z.string()).optional(),
  /** Raw platform fulfillment status: `unfulfilled`, `partial`, `fulfilled`, `restocked`, `null`. */
  fulfillmentStatusRaw: z.array(z.string()).optional(),
  /** Order age in hours; useful for "still unconfirmed after N hours → pending_review". */
  minAgeHours: z.number().min(0).optional(),
  sourceChannels: z.array(z.string()).optional(),
});
export type StateRuleConditions = z.infer<typeof stateRuleConditionsSchema>;

export const stateRuleSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  priority: z.number().int(),
  conditions: stateRuleConditionsSchema,
  resultStatus: z.enum(ORDER_STATUSES),
  isActive: z.boolean().default(true),
});
export type StateRule = z.infer<typeof stateRuleSchema>;

export interface StateInput {
  platformTags: readonly string[];
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  financialStatusRaw: string | null;
  fulfillmentStatusRaw: string | null;
  cancelledAt: Date | null;
  placedAt: Date;
  sourceChannel?: string | null;
  /** Resolved shipment status, when a shipment exists. */
  shipmentStatus?: ShipmentStatus | null;
  /** From the returns module: fraction of lines returned (0..1). */
  returnedFraction?: number;
  /** Operator-set status (status_source = manual). */
  manualStatus?: OrderStatus | null;
  /** Set when the order was cancelled and recreated (line change or merge): a final state. */
  replacedByOrderId?: string | null;
  now?: Date;
}

export interface StateDerivation {
  status: OrderStatus;
  /** Which element decided: `override:<fact>`, `manual`, `rule:<id>`, `default`. */
  reason: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export function ruleMatches(rule: StateRule, input: StateInput, now = input.now ?? new Date()): boolean {
  const c = rule.conditions;
  const tags = new Set(input.platformTags.map(norm));
  if (c.tagsAny && !c.tagsAny.some((t) => tags.has(norm(t)))) return false;
  if (c.tagsAll && !c.tagsAll.every((t) => tags.has(norm(t)))) return false;
  if (c.tagsNone && c.tagsNone.some((t) => tags.has(norm(t)))) return false;
  if (c.paymentMethods && !c.paymentMethods.includes(input.paymentMethod)) return false;
  if (c.paymentStatuses && !c.paymentStatuses.includes(input.paymentStatus)) return false;
  if (c.financialStatusRaw && !c.financialStatusRaw.map(norm).includes(norm(input.financialStatusRaw ?? "null"))) return false;
  if (c.fulfillmentStatusRaw && !c.fulfillmentStatusRaw.map(norm).includes(norm(input.fulfillmentStatusRaw ?? "null"))) return false;
  if (c.sourceChannels && !c.sourceChannels.map(norm).includes(norm(input.sourceChannel ?? ""))) return false;
  if (c.minAgeHours !== undefined) {
    const ageHours = (now.getTime() - input.placedAt.getTime()) / 36e5;
    if (ageHours < c.minAgeHours) return false;
  }
  return true;
}

/** Fallback used when no rule matches: the platform's own payment and fulfillment facts. */
export function defaultStatus(input: StateInput): OrderStatus {
  const f = norm(input.fulfillmentStatusRaw ?? "");
  if (f === "fulfilled") return "shipped";
  if (f === "partial" || f === "in_progress") return "fulfilling";
  if (input.paymentStatus === "paid") return "confirmed";
  return "new";
}

export function deriveOrderStatus(input: StateInput, rules: readonly StateRule[]): StateDerivation {
  // 1. Hard facts beat everything, including manual statuses. A replaced order stays cancelled
  // even when the platform cancel failed or a later sync reopens it: the replacement is the live one.
  if (input.replacedByOrderId) return { status: "cancelled", reason: "override:replaced" };
  if (input.cancelledAt) return { status: "cancelled", reason: "override:cancelled" };
  if (input.paymentStatus === "voided") return { status: "cancelled", reason: "override:voided" };
  if ((input.returnedFraction ?? 0) >= 0.999) return { status: "returned", reason: "override:returned" };
  if (input.paymentStatus === "refunded") return { status: "refunded", reason: "override:refunded" };
  if ((input.returnedFraction ?? 0) > 0) return { status: "returned_partial", reason: "override:returned_partial" };
  if (input.shipmentStatus === "delivered") return { status: "delivered", reason: "override:delivered" };
  // 2. Operator decisions stick until a hard fact changes.
  if (input.manualStatus) return { status: input.manualStatus, reason: "manual" };
  // 3. Shipment in transit beats configuration.
  if (input.shipmentStatus && ["in_transit", "out_for_delivery", "attempted", "exception", "label_created"].includes(input.shipmentStatus)) {
    return { status: "shipped", reason: "override:shipment" };
  }
  // 4. Tenant rules.
  const ordered = [...rules].filter((r) => r.isActive).sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) if (ruleMatches(rule, input)) return { status: rule.resultStatus, reason: `rule:${rule.id}` };
  // 5. Platform default.
  return { status: defaultStatus(input), reason: "default" };
}

/** Preview helper for the rules UI: what would each sample order become? */
export function previewRules(samples: readonly { id: string; input: StateInput; currentStatus: OrderStatus }[], rules: readonly StateRule[]) {
  return samples.map((s) => {
    const next = deriveOrderStatus({ ...s.input, manualStatus: null }, rules);
    return { id: s.id, current: s.currentStatus, next: next.status, reason: next.reason, changed: next.status !== s.currentStatus };
  });
}

/** Sensible starting rules for a new tenant. Tags are examples, not assumptions. */
export function defaultStateRules(): StateRule[] {
  return [
    {
      id: "paid-confirmed",
      name: "Paid orders are confirmed",
      priority: 100,
      conditions: { paymentStatuses: ["paid"], fulfillmentStatusRaw: ["null", "unfulfilled"] },
      resultStatus: "confirmed",
      isActive: true,
    },
    {
      id: "unpaid-review",
      name: "Unpaid orders need review",
      priority: 200,
      conditions: { paymentStatuses: ["pending"] },
      resultStatus: "pending_review",
      isActive: true,
    },
  ];
}
