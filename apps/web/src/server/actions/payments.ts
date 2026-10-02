"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@keel/db";
import { PAYMENT_METHODS } from "@keel/core";
import { PaymentError, recordManualPayment, refundOrder, runPayoutsSync } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const idSchema = z.string().uuid();

function paymentFailure(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof PaymentError) return e.code === "platform_error" ? fail("platform_error", { platform: e.message }) : fail(e.code);
  throw e;
}

const paymentSchema = z.object({ orderId: idSchema, amountMinor: z.number().int().positive().max(1_000_000_000), occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), method: z.enum(PAYMENT_METHODS), note: z.string().max(500).nullish() });

/** Records a payment received outside checkout (any method); the platform is updated through the outbox. */
export async function recordPaymentAction(slug: string, input: unknown): Promise<ActionResult<{ fullyPaid: boolean; outstandingMinor: number }>> {
  try {
    const ctx = await requireAction(slug, "record_payment", "orders");
    const parsed = paymentSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    // a date without time: noon in UTC keeps the day the same in every timezone the team works in
    const occurredAt = d.occurredAt === new Date().toISOString().slice(0, 10) ? new Date() : new Date(`${d.occurredAt}T12:00:00Z`);
    const r = await ctx.run(async (tx) => {
      const res = await recordManualPayment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { orderId: d.orderId, amountMinor: d.amountMinor, occurredAt, method: d.method, note: d.note ?? null });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.payment_recorded", entityType: "order", entityId: d.orderId, diff: res.paymentStatus !== res.previousPaymentStatus ? { paymentStatus: { from: res.previousPaymentStatus, to: res.paymentStatus } } : {}, metadata: { amountMinor: res.amountMinor, method: d.method, occurredAt: occurredAt.toISOString(), transactionId: res.transactionId } });
      return res;
    });
    if (r.write) await dispatchPlatformWrites(ctx, [r.write]);
    revalidatePath(`/t/${slug}/orders/${d.orderId}`);
    return ok({ fullyPaid: r.fullyPaid, outstandingMinor: r.outstandingMinor });
  } catch (e) {
    return paymentFailure(e);
  }
}

const refundSchema = z.object({ orderId: idSchema, amountMinor: z.number().int().positive().max(1_000_000_000), lines: z.array(z.object({ orderLineId: idSchema, quantity: z.number().int().positive().max(100_000) })).max(200).default([]), restock: z.boolean().default(false), locationId: idSchema.nullish(), note: z.string().max(500).nullish(), notify: z.boolean().default(false), requestId: z.string().uuid().nullish() });

/** Money refund on a paid order, written to the platform first; Keel records what the platform accepted. */
export async function refundOrderAction(slug: string, input: unknown): Promise<ActionResult<{ amountMinor: number; requestedMinor: number; refundedMinor: number }>> {
  try {
    const ctx = await requireAction(slug, "refund_order", "orders");
    const parsed = refundSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await refundOrder({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, d);
      if (!res.duplicate) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.refunded", entityType: "order", entityId: d.orderId, diff: { refundedMinor: { from: res.previousRefundedMinor, to: res.refundedMinor }, ...(res.paymentStatus !== res.previousPaymentStatus ? { paymentStatus: { from: res.previousPaymentStatus, to: res.paymentStatus } } : {}) }, metadata: { amountMinor: res.amountMinor, requestedMinor: res.requestedMinor, lines: d.lines, restock: d.restock, transactionId: res.transactionId } });
      return res;
    });
    revalidatePath(`/t/${slug}/orders/${d.orderId}`);
    return ok({ amountMinor: r.amountMinor, requestedMinor: r.requestedMinor, refundedMinor: r.refundedMinor });
  } catch (e) {
    return paymentFailure(e);
  }
}

/** "Sync payouts" on the payouts page: one pass of the resumable payouts sync (the daily job does the same). */
export async function syncPayoutsAction(slug: string): Promise<ActionResult<{ payouts: number; transactions: number; finished: boolean }>> {
  try {
    const ctx = await requireAction(slug, "manage_integrations", "analytics");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run((tx) => runPayoutsSync({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, { budgetMs: 15_000 }));
    if (r.error) return fail("platform_error", { platform: r.error });
    revalidatePath(`/t/${slug}/analytics/payouts`);
    return ok({ payouts: r.payouts, transactions: r.transactions, finished: r.finished });
  } catch (e) {
    return paymentFailure(e);
  }
}
