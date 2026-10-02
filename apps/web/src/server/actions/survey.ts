"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DEFAULT_SURVEY_CONFIG } from "@hullwise/core";
import { recordAudit, withTenant } from "@hullwise/db";
import { saveSurveySettings, submitSurveyAnswer, SurveyError, surveyTenantForSlug } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const answerSchema = z.object({ order: z.string().max(64), signature: z.string().max(64), answer: z.string().max(40), other: z.string().max(300).optional(), locale: z.string().max(5) });

/** Public: the customer's answer from the survey page. The signed link is the only credential. */
export async function submitSurveyAction(slug: string, input: unknown): Promise<ActionResult> {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_answer");
  const tenant = await surveyTenantForSlug(slug);
  if (!tenant) return fail("not_found");
  try {
    await withTenant(tenant.id, (tx) => submitSurveyAnswer({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }, { orderExternalId: parsed.data.order, signature: parsed.data.signature, answerKey: parsed.data.answer, otherText: parsed.data.other, locale: parsed.data.locale }));
    return ok();
  } catch (e) {
    if (e instanceof SurveyError) return fail(e.code);
    throw e;
  }
}

const settingsSchema = z.object({ enabled: z.boolean(), config: z.unknown() });

/** Staff: survey texts, options and blend weight. Marketing owns attribution. */
export async function saveSurveySettingsAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "analytics");
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await saveSurveySettings({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { enabled: parsed.data.enabled, config: parsed.data.config ?? DEFAULT_SURVEY_CONFIG });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "survey.settings_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: { enabled: { from: null, to: parsed.data.enabled } } });
    });
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof SurveyError) return fail(e.code);
    throw e;
  }
}
