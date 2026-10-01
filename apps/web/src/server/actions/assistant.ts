"use server";
import { revalidatePath } from "next/cache";
import { and, eq, schema } from "@keel/db";
import { AssistantError, askAssistant, deleteAssistantThread, getLlmProviderFor, type AssistantOutcome, type TenantRunner } from "@keel/services";
import { ForbiddenError, requireWrite } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Asks the assistant on the store's own Anthropic key. The loop opens one short tenant
 * transaction per read or write, never one across a model call, so it gets a runner instead of a
 * transaction. A rejected key marks the integration in error, where the owner sees it.
 */
export async function askAssistantAction(slug: string, threadId: string | null, question: string): Promise<ActionResult<{ threadId: string; outcome: AssistantOutcome; errorCode?: string }>> {
  try {
    const ctx = await requireWrite(slug, "assistant");
    const run: TenantRunner = (fn) => ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
    const llm = await run((s) => getLlmProviderFor(s));
    if (!llm) return fail("not_connected");
    const r = await askAssistant(run, { tenant: { id: ctx.tenant.id, name: ctx.tenant.name, slug: ctx.tenant.slug, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings }, userId: ctx.user.id, role: ctx.role, activeAddons: ctx.activeAddons, locale: ctx.locale }, llm, { threadId, question: String(question ?? "") });
    if (r.outcome === "error" && r.errorCode === "auth")
      await ctx.run((tx) => tx.update(schema.integrations).set({ status: "error", lastError: "The Anthropic API key was rejected (authentication).", updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "anthropic"))));
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
