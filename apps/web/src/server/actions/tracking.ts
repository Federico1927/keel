"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@hullwise/db";
import { CONVERSION_PROVIDERS } from "@hullwise/integrations";
import { enqueueConversions, getConversionSinkFor, ingestPixelBatch, recheckConversionAdjustments, retryFailedConversions, saveConversionSettings, savePixelSettings, sendDueConversions, type SendSummary } from "@hullwise/services";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const guard = (slug: string) => requireAction(slug, "manage_integrations", "integrations");
const actor = (ctx: Awaited<ReturnType<typeof guard>>) => ({ type: "user" as const, userId: ctx.user.id });
function handle(e: unknown) {
  if (e instanceof ForbiddenError) return fail("forbidden");
  throw e;
}

const pixelSchema = z.object({ enabled: z.boolean(), allowedOrigins: z.string().max(2000), lookbackDays: z.coerce.number().int().min(1).max(90) });

export async function savePixelSettingsAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await guard(slug);
    const parsed = pixelSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await savePixelSettings({ tenantId: ctx.tenant.id, tx, actor: actor(ctx) }, { enabled: parsed.data.enabled, allowedOrigins: parsed.data.allowedOrigins.split(/[\s,]+/).filter(Boolean), lookbackDays: parsed.data.lookbackDays });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "pixel.settings_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: { enabled: { from: null, to: parsed.data.enabled } } });
    });
    revalidatePath(`/t/${slug}/integrations/tracking`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** A synthetic page view through the same ingest path as the browser, to check the pipeline end to end. */
export async function sendTestPixelEventAction(slug: string): Promise<ActionResult> {
  try {
    const ctx = await guard(slug);
    const id = `test${Date.now().toString(36)}`;
    await ctx.run((tx) => ingestPixelBatch({ tenantId: ctx.tenant.id, tx, actor: actor(ctx) }, [{ event: "page_view", anonymousId: `${id}-a`, sessionId: `${id}-s`, url: "https://hullwise.test/?utm_source=hullwise&utm_medium=test", referrer: null, props: {} }], { ip: "hullwise-test", userAgent: "Hullwise test event" }));
    revalidatePath(`/t/${slug}/integrations/tracking`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

const conversionSchema = z.object({ provider: z.enum(CONVERSION_PROVIDERS), enabled: z.boolean(), destinationId: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]*$/), testEventCode: z.string().trim().max(64), requireConsent: z.boolean(), lookbackDays: z.coerce.number().int().min(1).max(90) });

export async function saveConversionSettingsAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await guard(slug);
    const parsed = conversionSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    if (d.enabled && !d.destinationId) return fail("destination_required");
    await ctx.run(async (tx) => {
      await saveConversionSettings({ tenantId: ctx.tenant.id, tx, actor: actor(ctx) }, { provider: d.provider, enabled: d.enabled, destinationId: d.destinationId || null, testEventCode: d.testEventCode || null, requireConsent: d.requireConsent, lookbackDays: d.lookbackDays });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "conversions.settings_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: { provider: { from: null, to: d.provider }, enabled: { from: null, to: d.enabled }, requireConsent: { from: null, to: d.requireConsent } } });
    });
    revalidatePath(`/t/${slug}/integrations/tracking`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Runs the queue now instead of waiting for the five-minute job; failed events are retried first. */
export async function runConversionsNowAction(slug: string, retryFailed: boolean): Promise<ActionResult<SendSummary[]>> {
  try {
    const ctx = await guard(slug);
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: actor(ctx) };
      if (retryFailed) for (const p of CONVERSION_PROVIDERS) await retryFailedConversions(s, p);
      await enqueueConversions(s);
      await recheckConversionAdjustments(s);
      return sendDueConversions(s, (provider, settings) => getConversionSinkFor(s, provider, settings));
    });
    revalidatePath(`/t/${slug}/integrations/tracking`);
    return ok(result);
  } catch (e) {
    return handle(e);
  }
}
