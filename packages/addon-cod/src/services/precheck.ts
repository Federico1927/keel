import { and, desc, eq, inArray, lte, or, schema, sql } from "@keel/db";
import { normalizePhone } from "@keel/core";
import type { AddressProvider } from "@keel/integrations";
import { customerOrderHistory, type ServiceContext } from "@keel/services";
import { riskEconomics } from "../economics";
import { recipientKey } from "../risk";
import type { ScoreFactor } from "../scoring";
import type { CodSettings, RiskTier } from "../settings";
import { getCodSettings, scoreQueueItem } from "./index";

/**
 * What the operator should know before calling (C.7) and the money side of the recipient's risk
 * (C.14). Read-only except for a refreshed score when the stored one is stale.
 */

export const SCORE_STALE_HOURS = 6;

export interface PrecheckAddress {
  orderId: string;
  orderName: string;
  placedAt: Date;
  address: string;
}

export async function orderPrecheck(ctx: ServiceContext, orderId: string, opts: { timezone: string; settings?: CodSettings; addressProvider?: AddressProvider }): Promise<{ score: number | null; recomputed: boolean; flagged: ScoreFactor[]; previousAddresses: PrecheckAddress[] } | null> {
  const now = ctx.now ?? new Date();
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item) return null;
  const breakdown = (item.scoreBreakdown ?? {}) as { factors?: ScoreFactor[]; computedAt?: string; attempts?: number };
  const open = ["pending", "scheduled", "unreachable", "confirm_scheduled"].includes(item.status);
  const stale = !breakdown.factors || !breakdown.computedAt || now.getTime() - new Date(breakdown.computedAt).getTime() > SCORE_STALE_HOURS * 3600e3 || (breakdown.attempts ?? item.attemptsCount) !== item.attemptsCount;
  let factors = breakdown.factors ?? [];
  let score = item.score;
  let recomputed = false;
  if (open && stale) {
    const r = await scoreQueueItem(ctx, orderId, { settings: opts.settings, timezone: opts.timezone, addressProvider: opts.addressProvider });
    factors = r.factors;
    score = r.score;
    recomputed = true;
  }
  const flagged = factors.filter((f) => f.severity === "critical" || f.severity === "warning");
  const [order] = await ctx.tx.select({ addressKey: schema.orders.addressKey }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  const history = await customerOrderHistory(ctx, orderId);
  const others = history.orders.filter((o) => o.id !== orderId).slice(0, 40);
  const rows = others.length ? await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, addressKey: schema.orders.addressKey, address: schema.orders.shippingAddress, zip: schema.orders.shippingZip, city: schema.orders.shippingCity }).from(schema.orders).where(inArray(schema.orders.id, others.map((o) => o.id))).orderBy(desc(schema.orders.placedAt)) : [];
  const seen = new Set<string>(order?.addressKey ? [order.addressKey] : []);
  const previousAddresses: PrecheckAddress[] = [];
  for (const r of rows) {
    const a = (r.address ?? {}) as { address1?: string | null; zip?: string | null; city?: string | null };
    const text = [a.address1, [a.zip ?? r.zip, a.city ?? r.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const key = r.addressKey ?? text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    previousAddresses.push({ orderId: r.id, orderName: r.name, placedAt: r.placedAt, address: text });
    if (previousAddresses.length >= 5) break;
  }
  return { score, recomputed, flagged, previousAddresses };
}

/** Cost of one refused parcel: the setting, else twice the tenant's shipping-cost estimate. */
async function refusalCost(ctx: ServiceContext, settings: CodSettings, now: Date): Promise<number> {
  if (settings.refusalCostMinor > 0) return settings.refusalCostMinor;
  const day = now.toISOString().slice(0, 10);
  const [row] = await ctx.tx.select({ amount: schema.costSettings.amountMinor }).from(schema.costSettings).where(and(eq(schema.costSettings.tenantId, ctx.tenantId), eq(schema.costSettings.kind, "shipping_per_order"), lte(schema.costSettings.validFrom, day))).orderBy(desc(schema.costSettings.validFrom)).limit(1);
  return 2 * (row?.amount ?? 0);
}

const mask = (k: string) => (k.startsWith("email:") ? k.replace(/^email:(.{2}).*(@.*)$/, "email:$1***$2") : k.replace(/\d(?=\d{3})/g, "•"));

export interface RiskPanel {
  recipientKey: string | null;
  tier: RiskTier | null;
  override: string | null;
  ordersTotal: number;
  ordersRefused: number;
  refusedPct: number | null;
  wastedMinor: number;
  expectedValueMinor: number | null;
  marginMinor: number | null;
  refusalCostMinor: number;
  /** Other phones (masked) seen with this recipient's email, and emails with this phone. */
  linkedKeys: string[];
}

export async function riskPanel(ctx: ServiceContext, orderId: string, settings?: CodSettings): Promise<RiskPanel | null> {
  const s = settings ?? (await getCodSettings(ctx));
  const now = ctx.now ?? new Date();
  const [o] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o) return null;
  const addr = (o.shippingAddress ?? {}) as { phone?: string | null };
  const phone = o.phoneE164 ?? normalizePhone(o.phone ?? addr.phone ?? null, o.shippingCountry ?? "US");
  const key = recipientKey(phone, o.emailNormalized);
  const [profile] = key ? await ctx.tx.select().from(schema.codRecipientProfiles).where(and(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId), eq(schema.codRecipientProfiles.recipientKey, key))).limit(1) : [];
  const [item] = await ctx.tx.select({ score: schema.codQueueItems.score }).from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, orderId)).limit(1);
  // linked identities: the same email with other phones, the same phone with other emails
  const idConds = [o.emailNormalized ? eq(schema.orders.emailNormalized, o.emailNormalized) : undefined, phone ? eq(schema.orders.phoneE164, phone) : undefined].filter(Boolean);
  const linked = idConds.length ? await ctx.tx.selectDistinct({ phone: schema.orders.phoneE164, email: schema.orders.emailNormalized }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), or(...idConds))).limit(50) : [];
  const linkedKeys = [...new Set(linked.flatMap((l) => [l.phone && l.phone !== phone ? l.phone : null, l.email && l.email !== o.emailNormalized ? `email:${l.email}` : null]).filter((x): x is string => Boolean(x)))].slice(0, 8).map(mask);
  // carrier-billed cost of this recipient's refusals, when imported
  const [known] = phone || o.emailNormalized ? await ctx.tx.select({ cost: sql<number | null>`sum(${schema.codCarrierOutcomes.costMinor})::int`, n: sql<number>`count(*)::int` }).from(schema.codCarrierOutcomes).innerJoin(schema.orders, eq(schema.orders.id, schema.codCarrierOutcomes.orderId)).where(and(eq(schema.codCarrierOutcomes.tenantId, ctx.tenantId), eq(schema.codCarrierOutcomes.outcome, "refused"), or(...idConds))) : [];
  const lines = await ctx.tx.select({ qty: schema.orderLines.currentQuantity, price: schema.orderLines.unitPriceMinor, cost: schema.orderLines.unitCostMinor, isAncillary: schema.orderLines.isAncillary }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)));
  const product = lines.filter((l) => !l.isAncillary && l.qty > 0);
  const marginMinor = product.length && product.every((l) => l.cost !== null) ? product.reduce((sum, l) => sum + l.qty * (l.price - (l.cost ?? 0)), 0) - o.discountMinor - o.taxMinor : null;
  const costEach = await refusalCost(ctx, s, now);
  const refused = profile?.ordersReturned ?? 0;
  const eco = riskEconomics({ score: item?.score ?? null, marginMinor, totalMinor: o.totalMinor, refusalCostMinor: costEach, ordersTotal: profile?.ordersTotal ?? 0, ordersRefused: refused, knownWastedMinor: known && known.n > 0 && known.cost !== null ? known.cost + Math.max(0, refused - known.n) * costEach : null });
  return { recipientKey: key ? mask(key) : null, tier: (profile?.tier as RiskTier | undefined) ?? null, override: profile?.override ?? null, ordersTotal: profile?.ordersTotal ?? 0, ordersRefused: refused, ...eco, marginMinor, refusalCostMinor: costEach, linkedKeys };
}
