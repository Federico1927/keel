"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@keel/config";
import { and, eq, inArray, recordAudit, schema } from "@keel/db";
import { createReturn, ReturnError, saveReturnReason, setReturnReasonActive, transitionReturn } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireAction, requirePage } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const createSchema = z.object({
  orderId: z.string().uuid(),
  reasonCode: z.string().min(1),
  resolution: z.enum(["refund", "exchange", "voucher"]),
  lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.coerce.number().int().min(0) })).min(1),
  customerNote: z.string().max(1000).optional().nullable(),
  staffNote: z.string().max(1000).optional().nullable(),
  overrideWindow: z.boolean().optional(),
});

async function requireReturnsWrite(slug: string) {
  const ctx = await requirePage(slug, "returns");
  if (!canWritePage(ctx.role, "returns")) throw new ForbiddenError("edit");
  return ctx;
}

export async function createReturnAction(slug: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const created = await ctx.run(async (tx) => {
      const r = await createReturn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.settings, parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "return.created", entityType: "return", entityId: r.id, diff: { number: { from: null, to: r.number }, orderId: { from: null, to: parsed.data.orderId } } });
      return r;
    });
    revalidatePath(`/t/${slug}/returns`);
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    return ok({ id: created.id });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail(`return_${e.code}`);
    throw e;
  }
}

const transitionSchema = z.object({
  to: z.enum(["approved", "received", "inspected", "refunded", "exchanged", "voucher_issued", "rejected"]),
  note: z.string().max(1000).optional().nullable(),
  restock: z.object({ locationId: z.string().uuid(), lineIds: z.array(z.string().uuid()) }).optional().nullable(),
  inspection: z.array(z.object({ lineId: z.string().uuid(), outcome: z.enum(["intact", "damaged", "missing"]), amountMinor: z.coerce.number().int().min(0) })).optional(),
  refundAmountMinor: z.coerce.number().int().min(0).optional().nullable(),
  voucherCode: z.string().max(60).optional().nullable(),
  fault: z.enum(["merchant", "customer", "undetermined"]).optional(),
  pushToPlatform: z.boolean().optional(),
});

export async function transitionReturnAction(slug: string, returnId: string, input: unknown): Promise<ActionResult<{ next: string }>> {
  try {
    const ctx = await requireAction(slug, "approve_return", "returns");
    const parsed = transitionSchema.safeParse(input);
    if (!parsed.success || !z.string().uuid().safeParse(returnId).success) return fail("invalid_input");
    const platform = parsed.data.pushToPlatform ? await getCommercePlatform(ctx) : null;
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await transitionReturn(s, {
        returnId,
        ...parsed.data,
        pushRestock: platform
          ? async (lines) => {
              const [req] = await tx.select({ orderId: schema.returnRequests.orderId }).from(schema.returnRequests).where(eq(schema.returnRequests.id, returnId)).limit(1);
              const [order] = await tx.select({ externalId: schema.orders.externalId }).from(schema.orders).where(eq(schema.orders.id, req!.orderId)).limit(1);
              const locs = await tx.select({ id: schema.locations.id, externalId: schema.locations.externalId }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenant.id), inArray(schema.locations.id, lines.map((l) => l.locationId))));
              const ols = await tx.select({ variantId: schema.orderLines.variantId, externalId: schema.orderLines.externalId }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, req!.orderId), inArray(schema.orderLines.variantId, lines.map((l) => l.variantId))));
              if (!order?.externalId) return;
              await platform.restockReturn(order.externalId, lines.map((l) => ({ orderLineExternalId: ols.find((o) => o.variantId === l.variantId)?.externalId ?? l.variantId, quantity: l.quantity, locationExternalId: locs.find((x) => x.id === l.locationId)?.externalId ?? l.locationId })));
            }
          : undefined,
      });
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: `return.${parsed.data.to}`, entityType: "return", entityId: returnId, diff: { status: { from: r.previous, to: r.next } } });
      return r;
    });
    revalidatePath(`/t/${slug}/returns`);
    revalidatePath(`/t/${slug}/returns/${returnId}`);
    return ok({ next: result.next });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail(`return_${e.code}`);
    throw e;
  }
}

const reasonSchema = z.object({ code: z.string().min(1).max(40), label: z.string().min(1).max(120), defaultFault: z.enum(["merchant", "customer", "undetermined"]), sortOrder: z.coerce.number().int().min(0).optional() });

export async function saveReturnReasonAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const parsed = reasonSchema.safeParse({ code: formData.get("code"), label: formData.get("label"), defaultFault: formData.get("defaultFault"), sortOrder: formData.get("sortOrder") || 0 });
    if (!parsed.success) return fail("invalid_input");
    const reasonId = String(formData.get("reasonId") || "") || undefined;
    await ctx.run(async (tx) => {
      const id = await saveReturnReason({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, parsed.data, reasonId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: reasonId ? "return_reason.updated" : "return_reason.created", entityType: "return_reason", entityId: id, diff: { code: { from: null, to: parsed.data.code }, label: { from: null, to: parsed.data.label } } });
    });
    revalidatePath(`/t/${slug}/returns/reasons`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail("invalid_input");
    throw e;
  }
}

export async function toggleReturnReasonAction(slug: string, reasonId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireReturnsWrite(slug);
    await ctx.run(async (tx) => {
      await setReturnReasonActive({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, reasonId, isActive);
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "return_reason.toggled", entityType: "return_reason", entityId: reasonId, diff: { isActive: { from: !isActive, to: isActive } } });
    });
    revalidatePath(`/t/${slug}/returns/reasons`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
