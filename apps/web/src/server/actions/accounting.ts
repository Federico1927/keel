"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canDo } from "@hullwise/config";
import { recordAudit } from "@hullwise/db";
import { accountingSettingsSchema, type AccountingWaitReason } from "@hullwise/core";
import type { ConnectionTest } from "@hullwise/integrations";
import { AccountingError, connectAccounting, mockAccountingFor, repushAccountingDay, resyncAccountingAccounts, retryAccountingDay, runAccountingPush, saveAccountingSettings, testAccountingConnection, type AccountingRunResult } from "@hullwise/services";
import { analyticsTenant } from "@/server/analytics";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/* addon.accounting (#85): every action needs the add-on and write access to the accounting pages (owners and admins). */

const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
const by = (ctx: TenantContext) => auditActor(ctx);
const handle = (e: unknown): ActionResult<never> => {
  if (e instanceof ForbiddenError) return fail(e.message === "module_disabled" ? "module_disabled" : "forbidden");
  if (e instanceof AccountingError) return fail(`accounting_${e.code}`, e.details.accounts ? { accounts: e.details.accounts.join(", ") } : e.code === "provider" ? { platform: e.message } : undefined);
  throw e;
};
const revalidate = (slug: string) => {
  revalidatePath(`/t/${slug}/accounting`, "layout");
  revalidatePath(`/t/${slug}/integrations`);
};
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Connection actions also need `manage_integrations` (the integration card). */
async function requireManage(slug: string) {
  const ctx = await requireWrite(slug, "accounting");
  if (!canDo(ctx.role, "manage_integrations")) throw new ForbiddenError("manage_integrations");
  return ctx;
}

export async function connectAccountingAction(slug: string): Promise<ActionResult<{ accounts: number }>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run((tx) => connectAccounting(svc(ctx, tx), by(ctx)));
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

export async function testAccountingAction(slug: string): Promise<ActionResult<ConnectionTest>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run(async (tx) => {
      const test = await testAccountingConnection(svc(ctx, tx));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.tested", entityType: "integration", entityId: "accounting", diff: { ok: { from: null, to: test.ok } } });
      return test;
    });
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

export async function resyncAccountsAction(slug: string): Promise<ActionResult<{ accounts: number }>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run(async (tx) => {
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.resync_requested", entityType: "integration", entityId: "accounting" });
      return resyncAccountingAccounts(svc(ctx, tx));
    });
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

/** Mock mode only: the simulated system refuses the next push (rate limit), to see a failure and its retry. */
export async function simulateAccountingFailureAction(slug: string): Promise<ActionResult> {
  try {
    const ctx = await requireManage(slug);
    const mock = mockAccountingFor(ctx.tenant.id) ?? (await ctx.run(async (tx) => { await testAccountingConnection(svc(ctx, tx)); return mockAccountingFor(ctx.tenant.id); }));
    if (!mock) return fail("accounting_not_connected");
    // the next journal push is refused (a void or a test still answers), so a retry or a re-push shows the failed state
    mock.pushFailures.failNext("rate_limited");
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function saveAccountingSettingsAction(slug: string, input: z.input<typeof accountingSettingsSchema>): Promise<ActionResult> {
  try {
    const parsed = accountingSettingsSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requireWrite(slug, "accounting");
    await ctx.run((tx) => saveAccountingSettings(svc(ctx, tx), parsed.data, by(ctx)));
    revalidate(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Runs the daily tick for this store now (the worker does it every hour). */
export async function runAccountingNowAction(slug: string): Promise<ActionResult<AccountingRunResult>> {
  try {
    const ctx = await requireWrite(slug, "accounting");
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "accounting.run_requested", entityType: "accounting_journal" });
      return runAccountingPush(s, analyticsTenant(ctx), { by: by(ctx) });
    });
    if (!r.connected) return fail("accounting_not_connected");
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

export async function retryAccountingDayAction(slug: string, day: string): Promise<ActionResult<AccountingRunResult>> {
  try {
    if (!DAY.safeParse(day).success) return fail("invalid_input");
    const ctx = await requireWrite(slug, "accounting");
    const r = await ctx.run((tx) => retryAccountingDay(svc(ctx, tx), analyticsTenant(ctx), day, by(ctx)));
    revalidate(slug);
    return ok(r);
  } catch (e) {
    return handle(e);
  }
}

/** Voids the pushed journal of a day and pushes version + 1 (confirmed in a dialog, audited). */
export async function repushAccountingDayAction(slug: string, day: string, note: string | null): Promise<ActionResult<{ version: number; status: string }>> {
  try {
    if (!DAY.safeParse(day).success || (note !== null && note.length > 300)) return fail("invalid_input");
    const ctx = await requireWrite(slug, "accounting");
    const r = await ctx.run((tx) => repushAccountingDay(svc(ctx, tx), analyticsTenant(ctx), day, { note: note?.trim() || null, by: by(ctx) }));
    revalidate(slug);
    return ok(r);
  } catch (e) {
    if (e instanceof AccountingError && e.code === "not_ready") return fail("accounting_not_ready", { reasons: (e.details.reasons ?? []).map((x: AccountingWaitReason) => x.code).join(",") });
    return handle(e);
  }
}
