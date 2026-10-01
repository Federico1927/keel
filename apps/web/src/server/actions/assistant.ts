"use server";
import { revalidatePath } from "next/cache";
import { AssistantError, askAssistant, deleteAssistantThread, getLlmProvider, type AssistantOutcome, type TenantRunner } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Asks the assistant. The loop opens one short tenant transaction per read or write, never one
 * across a model call, so it gets a runner instead of a transaction.
 */
export async function askAssistantAction(slug: string, threadId: string | null, question: string): Promise<ActionResult<{ threadId: string; outcome: AssistantOutcome; errorCode?: string }>> {
  try {
    const ctx = await requireWrite(slug, "assistant");
    const run: TenantRunner = (fn) => ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
    const r = await askAssistant(run, { tenant: { id: ctx.tenant.id, name: ctx.tenant.name, slug: ctx.tenant.slug, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings }, userId: ctx.user.id, role: ctx.role, activeAddons: ctx.activeAddons, locale: ctx.locale }, getLlmProvider(), { threadId, question: String(question ?? "") });
    revalidatePath(`/t/${slug}/assistant`);
    return ok({ threadId: r.threadId, outcome: r.outcome, errorCode: r.errorCode });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof AssistantError) return fail(e.code);
    throw e;
  }
}

export async function deleteAssistantThreadAction(slug: string, threadId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "assistant");
    const deleted = await ctx.run((tx) => deleteAssistantThread({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id, threadId));
    if (!deleted) return fail("not_found");
    revalidatePath(`/t/${slug}/assistant`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}
