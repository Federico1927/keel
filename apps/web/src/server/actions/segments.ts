"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage, isPageEnabled } from "@keel/config";
import { recordAudit } from "@keel/db";
import { deleteSegment, evaluateSegment, previewSegment, saveSegment, SegmentRuleError, type SegmentPreview } from "@keel/services";
import { ForbiddenError, requirePage } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const inputSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional().nullable(), rules: z.unknown(), holdoutPercentage: z.coerce.number().int().min(0).max(50) });

async function requireSegmentsWrite(slug: string) {
  const ctx = await requirePage(slug, "segments");
  if (!canWritePage(ctx.role, "segments")) throw new ForbiddenError("edit");
  return ctx;
}

export async function previewSegmentAction(slug: string, rules: unknown): Promise<ActionResult<SegmentPreview>> {
  try {
    const ctx = await requirePage(slug, "segments");
    const preview = await ctx.run((tx) => previewSegment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, rules));
    return ok(preview);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof SegmentRuleError) return fail("invalid_rules");
    throw e;
  }
}

export async function saveSegmentAction(slug: string, input: unknown, segmentId?: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireSegmentsWrite(slug);
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    // control groups belong to the customer-campaigns add-on: without it a segment never holds anyone out
    if (!isPageEnabled("customer_campaigns", ctx.activeAddons)) parsed.data.holdoutPercentage = 0;
    const id = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const id = await saveSegment(s, { name: parsed.data.name, description: parsed.data.description ?? null, rules: parsed.data.rules, holdoutPercentage: parsed.data.holdoutPercentage }, segmentId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: segmentId ? "segment.updated" : "segment.created", entityType: "segment", entityId: id, diff: { name: { from: null, to: parsed.data.name }, holdoutPercentage: { from: null, to: parsed.data.holdoutPercentage } } });
      await evaluateSegment(s, id);
      return id;
    });
    revalidatePath(`/t/${slug}/segments`);
    revalidatePath(`/t/${slug}/segments/${id}`);
    return ok({ id });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof SegmentRuleError) return fail("invalid_rules");
    throw e;
  }
}

export async function evaluateSegmentAction(slug: string, segmentId: string): Promise<ActionResult<{ count: number; holdout: number }>> {
  try {
    const ctx = await requireSegmentsWrite(slug);
    if (!z.string().uuid().safeParse(segmentId).success) return fail("invalid_input");
    const result = await ctx.run(async (tx) => {
      const r = await evaluateSegment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, segmentId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.evaluated", entityType: "segment", entityId: segmentId, diff: { count: { from: null, to: r.count } } });
      return r;
    });
    revalidatePath(`/t/${slug}/segments`);
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof Error && e.message === "segment_not_found") return fail("not_found");
    throw e;
  }
}

export async function deleteSegmentAction(slug: string, segmentId: string): Promise<ActionResult> {
  try {
    const ctx = await requireSegmentsWrite(slug);
    if (!z.string().uuid().safeParse(segmentId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await deleteSegment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, segmentId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.deleted", entityType: "segment", entityId: segmentId });
    });
    revalidatePath(`/t/${slug}/segments`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
