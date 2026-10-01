import { z } from "zod";

/** Factor keys of the delivery score; weights are relative (0–50), not percentages. */
export const SCORE_FACTORS = ["customer_history", "cod_attempts", "time_elapsed", "cart_variants", "cart_quantity", "address_quality", "similar_orders", "order_value", "night_order", "recent_cancellations", "duplicate_orders", "prepaid_history"] as const;
export type ScoreFactorKey = (typeof SCORE_FACTORS)[number];

export const DEFAULT_WEIGHTS: Record<ScoreFactorKey, number> = {
  customer_history: 35,
  cod_attempts: 8,
  time_elapsed: 4,
  cart_variants: 5,
  cart_quantity: 3,
  address_quality: 5,
  similar_orders: 12,
  order_value: 3,
  night_order: 3,
  recent_cancellations: 6,
  duplicate_orders: 8,
  prepaid_history: 4,
};

export const RISK_TIERS = ["clean", "watch", "high_risk", "blacklisted"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const codSettingsSchema = z.object({
  weights: z.object(Object.fromEntries(SCORE_FACTORS.map((k) => [k, z.number().min(0).max(50).default(DEFAULT_WEIGHTS[k])])) as Record<ScoreFactorKey, z.ZodDefault<z.ZodNumber>>).prefault({}),
  /** `no_answer` attempts after which the item becomes unreachable. */
  unreachableAfterAttempts: z.number().int().min(1).max(10).default(3),
  /** Orders older than this never enter the queue (prevents a backlog explosion at install). */
  queueCutoffDays: z.number().int().min(1).max(365).default(60),
  timeElapsedWarnHours: z.number().int().min(1).default(72),
  customerHistoryHalfLifeDays: z.number().int().min(1).default(180),
  customerHistoryMinOrders: z.number().int().min(1).default(2),
  similarOrdersLookbackDays: z.number().int().min(7).default(180),
  similarOrdersMinSample: z.number().int().min(1).default(10),
  orderValueMultiple: z.number().min(1).default(2),
  nightFromHour: z.number().int().min(0).max(23).default(23),
  nightToHour: z.number().int().min(0).max(23).default(6),
  risk: z
    .object({
      watchMinReturns: z.number().int().min(1).default(1),
      highRiskMinReturns: z.number().int().min(1).default(2),
      blacklistMinReturns: z.number().int().min(1).default(3),
      recentMonths: z.number().int().min(1).default(12),
      recentWeight: z.number().min(0).max(1).default(1),
      oldWeight: z.number().min(0).max(1).default(0.5),
      redemptionConsecutiveDeliveries: z.number().int().min(1).default(3),
      redemptionDeliveriesPerReturn: z.number().int().min(0).default(1),
      penalties: z
        .object({
          watch: z.object({ multiplier: z.number().default(0.75), cap: z.number().default(65) }).prefault({}),
          high_risk: z.object({ multiplier: z.number().default(0.45), cap: z.number().default(40) }).prefault({}),
          blacklisted: z.object({ multiplier: z.number().default(0.1), cap: z.number().default(10) }).prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
});
export type CodSettings = z.infer<typeof codSettingsSchema>;

export function parseCodSettings(raw: unknown): CodSettings {
  const r = codSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : codSettingsSchema.parse({});
}
