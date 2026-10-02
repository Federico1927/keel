import { payoutTotals } from "@keel/core";
import { createRng } from "../rng";
import type { NormalizedBalanceTransaction, NormalizedPayout } from "../types";

/** Gateways settled by the platform's own processor (Shopify Payments, wallets included); PayPal, BNPL, transfers and cash are not. */
export const PROCESSOR_GATEWAYS = ["shopify_payments", "apple_pay", "google_pay", "shop_pay"] as const;
export const isProcessorGateway = (gateways: readonly string[]) => gateways.some((g) => (PROCESSOR_GATEWAYS as readonly string[]).includes(g.toLowerCase()));

export interface MockPaymentOrder {
  externalId: string;
  placedAt: Date;
  totalMinor: number;
  /** Money refunded on the processor (a cancelled paid order: the total). */
  refundedMinor: number;
  refundedAt?: Date | null;
  gateways: readonly string[];
}
export interface MockPayoutRefund {
  orderExternalId: string;
  amountMinor: number;
  at: Date;
}

const DAY = 864e5;
/** FNV-1a: a stable number per order, so its fee and dates never depend on which other orders are in the batch. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** Funds are paid out two days after the movement, weekends moved to Monday. */
function payoutDay(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 2, 8));
  const wd = d.getUTCDay();
  return wd === 6 ? new Date(d.getTime() + 2 * DAY) : wd === 0 ? new Date(d.getTime() + DAY) : d;
}
/** Processor pricing as the merchant sees it: domestic cards cheaper than international ones, by currency. */
function chargeFee(externalId: string, amountMinor: number, currency: string): number {
  const rng = createRng(hash(`fee:${externalId}`));
  const [bps, fixed] = currency === "USD" ? (rng.chance(0.88) ? [290, 30] : [390, 30]) : rng.chance(0.8) ? [150, 25] : [290, 25];
  return Math.round((amountMinor * bps) / 10_000) + fixed;
}

/**
 * Payouts and balance transactions a processor would report for these orders: one charge per paid
 * order with its actual fee, one refund per refunded amount, an occasional adjustment, grouped in
 * daily deposits two days later. Deterministic: the mock adapter and the seed produce the same data.
 */
export function buildMockPayouts(input: { orders: readonly MockPaymentOrder[]; refunds?: readonly MockPayoutRefund[]; currency: string; now: Date; since?: Date | null }): { payouts: NormalizedPayout[]; transactions: NormalizedBalanceTransaction[] } {
  const { currency, now } = input;
  const txns: NormalizedBalanceTransaction[] = [];
  const push = (t: Omit<NormalizedBalanceTransaction, "payoutExternalId" | "netMinor" | "currency">, payoutExternalId?: string) => {
    if (t.occurredAt > now) return;
    txns.push({ ...t, currency, netMinor: t.amountMinor - t.feeMinor, payoutExternalId: payoutExternalId ?? `mock-po-${dayKey(payoutDay(t.occurredAt)).replace(/-/g, "")}` });
  };
  for (const o of input.orders) {
    if (!isProcessorGateway(o.gateways) || o.totalMinor <= 0) continue;
    const at = new Date(o.placedAt.getTime() + 60_000);
    push({ externalId: `mock-bt-${o.externalId}-c`, type: "charge", orderExternalId: o.externalId, amountMinor: o.totalMinor, feeMinor: chargeFee(o.externalId, o.totalMinor, currency), occurredAt: at });
    const refunded = Math.min(o.totalMinor, Math.max(0, o.refundedMinor));
    if (refunded > 0) {
      const when = o.refundedAt ?? new Date(o.placedAt.getTime() + (5 + (hash(`r:${o.externalId}`) % 15)) * DAY);
      push({ externalId: `mock-bt-${o.externalId}-r`, type: "refund", orderExternalId: o.externalId, amountMinor: -refunded, feeMinor: 0, occurredAt: when > now ? new Date(now.getTime() - 36e5) : when });
    }
  }
  for (const [i, r] of (input.refunds ?? []).entries()) push({ externalId: `mock-bt-${r.orderExternalId}-r${i + 1}`, type: "refund", orderExternalId: r.orderExternalId, amountMinor: -Math.abs(r.amountMinor), feeMinor: 0, occurredAt: r.at });
  // about one deposit in twelve carries a processor adjustment (fee correction, chargeback fee)
  const days = new Set(txns.map((t) => t.payoutExternalId!));
  for (const id of days) {
    const h = hash(`adj:${id}`);
    if (h % 12 !== 0) continue;
    const d = id.slice("mock-po-".length);
    push({ externalId: `mock-bt-adj-${d}`, type: "adjustment", orderExternalId: null, amountMinor: -(150 + (h % 750)), feeMinor: 0, occurredAt: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T07:00:00Z`) }, id);
  }
  const byPayout = new Map<string, NormalizedBalanceTransaction[]>();
  for (const t of txns) byPayout.set(t.payoutExternalId!, [...(byPayout.get(t.payoutExternalId!) ?? []), t]);
  const today = dayKey(now);
  const payouts: NormalizedPayout[] = [];
  for (const [id, list] of byPayout) {
    const d = id.slice("mock-po-".length);
    const issuedAt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T08:00:00Z`);
    if (input.since && issuedAt < input.since) continue;
    const t = payoutTotals(list);
    const key = dayKey(issuedAt);
    payouts.push({ externalId: id, status: key > today ? "scheduled" : key === today ? "in_transit" : "paid", issuedAt, currency, grossMinor: t.grossMinor, refundsMinor: t.refundsMinor, adjustmentsMinor: t.adjustmentsMinor, feeMinor: t.feesMinor, netMinor: t.netMinor });
  }
  payouts.sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
  const kept = new Set(payouts.map((p) => p.externalId));
  return { payouts, transactions: txns.filter((t) => kept.has(t.payoutExternalId!)).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.externalId.localeCompare(b.externalId)) };
}
