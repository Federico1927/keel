"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@hullwise/config";
import { recordAudit } from "@hullwise/db";
import { deletePeriodCost, upsertPeriodCost } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requirePage } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const schema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  kind: z.enum(["fixed", "shipping", "other"]),
  label: z.string().max(80).default(""),
  estimate: z.coerce.number().min(0).max(1e9),
  /** Empty string = not known yet. */
  actual: z.union([z.literal(""), z.coerce.number().min(0).max(1e9)]).optional(),
  note: z.string().max(300).optional(),
});

async function requireCostsWrite(slug: string) {
  const ctx = await requirePage(slug, "analytics");
  if (!canWritePage(ctx.role, "settings")) throw new ForbiddenError("edit");
  return ctx;
}

/** Saves one cost line of one month (estimate and, when known, actual). Amounts arrive in major units. */
export async function savePeriodCostAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireCostsWrite(slug);
    const parsed = schema.safeParse({ period: formData.get("period"), kind: formData.get("kind"), label: formData.get("label") ?? "", estimate: formData.get("estimate") || 0, actual: formData.get("actual") ?? "", note: formData.get("note") ?? "" });
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    const actualMinor = d.actual === "" || d.actual === undefined ? null : Math.round(d.actual * 100);
    await ctx.run(async (tx) => {
      const svc = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await upsertPeriodCost(svc, { period: d.period, kind: d.kind, label: d.label, estimateMinor: Math.round(d.estimate * 100), actualMinor, note: d.note || null });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "period_cost.saved", entityType: "period_cost", entityId: r.id, diff: { estimateMinor: { from: r.before?.estimateMinor ?? null, to: Math.round(d.estimate * 100) }, actualMinor: { from: r.before?.actualMinor ?? null, to: actualMinor } }, metadata: { period: d.period, kind: d.kind, label: d.label } });
    });
    revalidatePath(`/t/${slug}/analytics/costs`);
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function deletePeriodCostAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireCostsWrite(slug);
    if (!z.string().uuid().safeParse(id).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await deletePeriodCost({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "period_cost.deleted", entityType: "period_cost", entityId: id });
    });
    revalidatePath(`/t/${slug}/analytics/costs`);
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
