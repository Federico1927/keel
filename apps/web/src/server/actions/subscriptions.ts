"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canDo, canWritePage } from "@hullwise/config";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { SUBSCRIPTION_ACTIONS, SUBSCRIPTION_INTERVALS } from "@hullwise/core";
import { IntegrationError, failedConnection, setupErrorOfTest, type ConnectionTest } from "@hullwise/integrations";
import { SubscriptionActionError, addSubscriptionNote, assignSubscription, getSubscriptionProviderFor, mockSubscriptionsFor, refreshSubscriberRisk, runSubscriptionSync, saveCancellationReason, subscriptionAction } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { verifySetup, type SetupFacts } from "@/server/integration-verify";
import { ForbiddenError, requirePage, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/* addon.subscriptions (#67): every action needs the add-on (requirePage/requireWrite answer module_disabled otherwise). */

const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
const handle = (e: unknown): ActionResult<never> => {
  if (e instanceof ForbiddenError) return fail(e.message === "module_disabled" ? "module_disabled" : "forbidden");
  if (e instanceof SubscriptionActionError) return fail(`subscription_${e.code}`);
  if (e instanceof IntegrationError) return fail("subscription_provider", { platform: e.message });
  throw e;
};
const revalidate = (slug: string, contractId?: string) => {
  revalidatePath(`/t/${slug}/subscriptions`, "layout");
  if (contractId) revalidatePath(`/t/${slug}/subscriptions/subscribers/${contractId}`);
};

const actionSchema = z.object({
  contractId: z.string().uuid(),
  action: z.enum(SUBSCRIPTION_ACTIONS),
  requestKey: z.string().min(4).max(80),
  resumeAt: z.string().optional().nullable(),
  lineId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  unit: z.enum(SUBSCRIPTION_INTERVALS).optional(),
  count: z.coerce.number().int().min(1).max(52).optional(),
  nextBillingAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().max(40).optional(),
  note: z.string().max(500).optional().nullable(),
});

/** A confirmed customer-care action, sent through the subscription app (one write per confirmation). */
export async function subscriptionActionAction(slug: string, input: z.input<typeof actionSchema>): Promise<ActionResult<{ replayed: boolean }>> {
  try {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requireWrite(slug, "subscriptions");
    const p = parsed.data;
    const r = await ctx.run((tx) => subscriptionAction(svc(ctx, tx), { ...p, nextBillingAt: p.nextBillingAt ? `${p.nextBillingAt}T12:00:00Z` : undefined, eventMetadata: ctx.impersonation ? { impersonatedBy: ctx.impersonation.adminUserId } : undefined }));
    revalidate(slug, p.contractId);
    return ok({ replayed: r.replayed });
  } catch (e) {
    return handle(e);
  }
}

export async function addSubscriptionNoteAction(slug: string, contractId: string, body: string, contacted: boolean): Promise<ActionResult> {
  try {
    if (!z.string().uuid().safeParse(contractId).success || !body.trim()) return fail("invalid_input");
    const ctx = await requireWrite(slug, "subscriptions");
    await ctx.run((tx) => addSubscriptionNote(svc(ctx, tx), contractId, body, { contacted }));
    revalidate(slug, contractId);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function assignSubscriptionAction(slug: string, contractId: string, userId: string | null): Promise<ActionResult> {
  try {
    if (!z.string().uuid().safeParse(contractId).success || (userId !== null && !z.string().uuid().safeParse(userId).success)) return fail("invalid_input");
    const ctx = await requireWrite(slug, "subscriptions");
    await ctx.run((tx) => assignSubscription(svc(ctx, tx), contractId, userId));
    revalidate(slug, contractId);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

const reasonSchema = z.object({ code: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80), kind: z.enum(["voluntary", "involuntary"]), keywords: z.string().max(600).default(""), isActive: z.boolean().default(true) });
/** The tenant's cancellation reason list: owners and admins edit it. */
export async function saveCancellationReasonAction(slug: string, input: z.input<typeof reasonSchema>): Promise<ActionResult> {
  try {
    const parsed = reasonSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requirePage(slug, "subscriptions");
    if (!canDo(ctx.role, "manage_settings")) return fail("forbidden");
    await ctx.run((tx) => saveCancellationReason(svc(ctx, tx), { ...parsed.data, keywords: parsed.data.keywords.split(",") }));
    revalidate(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/* ---------- the subscription app connection ---------- */

async function requireManage(slug: string) {
  const ctx = await requirePage(slug, "subscriptions");
  if (!canDo(ctx.role, "manage_integrations")) throw new ForbiddenError("manage_integrations");
  return ctx;
}

/** Test connection: the subscriptions found, or the plain-words reason and its fix (#90). */
export async function testSubscriptionProviderAction(slug: string): Promise<ActionResult<ConnectionTest & { provider?: string; setup?: string | null; verification?: SetupFacts | null }>> {
  try {
    const ctx = await requireManage(slug);
    const result = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      const provider = await getSubscriptionProviderFor(s);
      if (!provider) return { ok: false, error: "not connected" } satisfies ConnectionTest;
      const test = await provider.testConnection().catch(failedConnection);
      await tx.update(schema.integrations).set(test.ok ? { lastSuccessAt: new Date(), lastError: null, status: "connected", updatedAt: new Date() } : { lastError: test.error ?? "connection failed", status: "error", updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, provider.provider)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.tested", entityType: "integration", entityId: provider.provider, diff: { ok: { from: null, to: test.ok } } });
      return { ...test, provider: provider.provider, setup: test.ok ? null : setupErrorOfTest(provider.provider, test), verification: test.ok ? await verifySetup(provider.provider, s, ctx.tenant) : null };
    });
    revalidate(slug);
    revalidatePath(`/t/${slug}/integrations`);
    return ok(result);
  } catch (e) {
    return handle(e);
  }
}

/** Resync now, inline with a time budget (the add-on's tick does the same every 15 minutes). */
export async function resyncSubscriptionsAction(slug: string): Promise<ActionResult<{ summary: string; finished: boolean }>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      const provider = await getSubscriptionProviderFor(s);
      if (!provider) return null;
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.resync_requested", entityType: "integration", entityId: provider.provider });
      const run = await runSubscriptionSync(s, provider, { kind: "delta", budgetMs: 15_000 });
      await refreshSubscriberRisk(s);
      return run;
    });
    if (!r) return fail("subscription_no_provider");
    revalidate(slug);
    revalidatePath(`/t/${slug}/integrations`);
    return ok({ summary: r.error ?? `contracts:${r.contracts} attempts:${r.attempts} changed:${r.changed}`, finished: r.finished });
  } catch (e) {
    return handle(e);
  }
}

/** Mock mode only: the simulated app charges one active contract now, with a decline when asked. */
export async function simulateRenewalAction(slug: string, outcome: "success" | "card_expired" | "insufficient_funds"): Promise<ActionResult<{ summary: string }>> {
  try {
    const ctx = await requireManage(slug);
    if (!canWritePage(ctx.role, "subscriptions")) return fail("forbidden");
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      const provider = await getSubscriptionProviderFor(s);
      const mock = mockSubscriptionsFor(ctx.tenant.id);
      if (!provider || !mock || provider !== mock) return null;
      const [c] = await tx.select({ externalId: schema.subscriptionContracts.externalId }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenant.id), eq(schema.subscriptionContracts.status, "active"))).orderBy(schema.subscriptionContracts.nextBillingAt).limit(1);
      if (!c) return null;
      mock.simulateRenewal(c.externalId, outcome);
      return runSubscriptionSync(s, mock, { kind: "delta", budgetMs: 10_000 });
    });
    if (!r) return fail("subscription_no_provider");
    revalidate(slug);
    return ok({ summary: r.error ?? `changed:${r.changed}` });
  } catch (e) {
    return handle(e);
  }
}
