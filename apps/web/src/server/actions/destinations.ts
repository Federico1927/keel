"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canDo, isPageEnabled } from "@keel/config";
import { and, eq, recordAudit, schema } from "@keel/db";
import { AUDIENCE_PROVIDERS, type AudienceProvider } from "@keel/integrations";
import { addSegmentDestination, DestinationError, evaluateSegment, getAudienceDestinationFor, removeSegmentDestination, setDestinationAutoSync, syncSegmentDestination, type DestinationSyncResult } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/** Pushing customers to another platform is an export: segment write access plus the export permission. */
async function requireDestinations(slug: string) {
  const ctx = await requireWrite(slug, "segments");
  if (!canDo(ctx.role, "export")) throw new ForbiddenError("export");
  return ctx;
}
function handle(e: unknown) {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof DestinationError) return fail(e.code);
  throw e;
}
const user = (ctx: Awaited<ReturnType<typeof requireWrite>>) => ({ type: "user" as const, userId: ctx.user.id });

/** Live segments are re-checked within minutes of every order change; turning it on evaluates now. */
export async function setSegmentLiveAction(slug: string, segmentId: string, live: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "segments");
    await ctx.run(async (tx) => {
      await tx.update(schema.segments).set({ liveUpdates: live, updatedAt: new Date() }).where(and(eq(schema.segments.tenantId, ctx.tenant.id), eq(schema.segments.id, segmentId)));
      if (live) await evaluateSegment({ tenantId: ctx.tenant.id, tx, actor: user(ctx) }, segmentId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.live_updated", entityType: "segment", entityId: segmentId, diff: { liveUpdates: { from: !live, to: live } } });
    });
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

const addSchema = z.object({ provider: z.enum(AUDIENCE_PROVIDERS), audienceName: z.string().trim().min(1).max(120), autoSync: z.boolean() });

export async function addDestinationAction(slug: string, segmentId: string, input: unknown): Promise<ActionResult<{ id: string; sync: DestinationSyncResult }>> {
  try {
    const ctx = await requireDestinations(slug);
    const parsed = addSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const excludeHoldout = isPageEnabled("customer_campaigns", ctx.activeAddons);
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: user(ctx) };
      const id = await addSegmentDestination(s, { segmentId, ...parsed.data });
      const sync = await syncSegmentDestination(s, id, getAudienceDestinationFor(ctx.tenant.id, parsed.data.provider), { excludeHoldout });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.destination_added", entityType: "segment", entityId: segmentId, diff: { provider: { from: null, to: parsed.data.provider }, audienceName: { from: null, to: parsed.data.audienceName }, members: { from: null, to: sync.members } } });
      return { id, sync };
    });
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok(result);
  } catch (e) {
    return handle(e);
  }
}

export async function syncDestinationAction(slug: string, segmentId: string, destinationId: string): Promise<ActionResult<DestinationSyncResult>> {
  try {
    const ctx = await requireDestinations(slug);
    const excludeHoldout = isPageEnabled("customer_campaigns", ctx.activeAddons);
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: user(ctx) };
      const [d] = await tx.select({ provider: schema.segmentDestinations.provider }).from(schema.segmentDestinations).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenant.id), eq(schema.segmentDestinations.id, destinationId))).limit(1);
      if (!d) throw new DestinationError("not_found");
      await evaluateSegment(s, segmentId);
      const r = await syncSegmentDestination(s, destinationId, getAudienceDestinationFor(ctx.tenant.id, d.provider as AudienceProvider), { excludeHoldout });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.destination_synced", entityType: "segment", entityId: segmentId, diff: { added: { from: null, to: r.added }, removed: { from: null, to: r.removed }, status: { from: null, to: r.status } } });
      return r;
    });
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok(result);
  } catch (e) {
    return handle(e);
  }
}

export async function removeDestinationAction(slug: string, segmentId: string, destinationId: string): Promise<ActionResult> {
  try {
    const ctx = await requireDestinations(slug);
    await ctx.run(async (tx) => {
      await removeSegmentDestination({ tenantId: ctx.tenant.id, tx, actor: user(ctx) }, destinationId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "segment.destination_removed", entityType: "segment", entityId: segmentId, diff: {} });
    });
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function setDestinationAutoSyncAction(slug: string, segmentId: string, destinationId: string, autoSync: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireDestinations(slug);
    await ctx.run((tx) => setDestinationAutoSync({ tenantId: ctx.tenant.id, tx, actor: user(ctx) }, destinationId, autoSync));
    revalidatePath(`/t/${slug}/segments/${segmentId}`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}
