"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TASK_ENTITY_TYPES, TASK_STATUSES, type TaskRuleInput } from "@hullwise/core";
import { TaskError, createTask, deleteTaskRule, ensureDefaultTaskRules, saveTaskRule, updateTask, type ServiceContext } from "@hullwise/services";
import type { Transaction } from "@hullwise/db";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: Transaction): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

function mapError(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof TaskError) return fail(e.code);
  throw e;
}

const dateSchema = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.date().nullable());
const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  assigneeId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable().optional()),
  dueAt: dateSchema.optional(),
  entityType: z.preprocess((v) => (v === "" ? null : v), z.enum(TASK_ENTITY_TYPES).nullable().optional()),
  entityId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable().optional()),
});

/** New task, standalone or on a record. Anyone with write access to tasks can create one. */
export async function createTaskAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "tasks");
    const parsed = createSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    await ctx.run((tx) => createTask(svc(ctx, tx), { ...parsed.data, description: parsed.data.description || null }));
    revalidatePath(`/t/${slug}`, "layout");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const patchSchema = z.object({ status: z.enum(TASK_STATUSES).optional(), assigneeId: z.string().uuid().nullable().optional(), dueAt: z.coerce.date().nullable().optional() });

export async function updateTaskAction(slug: string, taskId: string, patch: { status?: string; assigneeId?: string | null; dueAt?: string | null }): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "tasks");
    const parsed = patchSchema.safeParse(patch);
    if (!z.string().uuid().safeParse(taskId).success || !parsed.success) return fail("invalid_input");
    await ctx.run((tx) => updateTask(svc(ctx, tx), taskId, parsed.data));
    revalidatePath(`/t/${slug}`, "layout");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const list = (v: FormDataEntryValue[]) => v.map(String).filter(Boolean);
const num = (v: FormDataEntryValue | null, d: number | null) => (v === null || v === "" ? d : Number(v));

export async function saveTaskRuleAction(slug: string, ruleId: string | null, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "tasks");
    const input: TaskRuleInput = {
      entityType: String(formData.get("entityType")) as TaskRuleInput["entityType"],
      statuses: list(formData.getAll("statuses")),
      minHoursInStatus: num(formData.get("minHoursInStatus"), 0) ?? 0,
      overdueAfterHours: formData.get("useDue") === "on" ? (num(formData.get("overdueAfterHours"), 0) ?? 0) : null,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? "").trim() || null,
      dueInHours: num(formData.get("dueInHours"), 24) ?? 24,
      assigneeMode: String(formData.get("assigneeMode") ?? "role") as TaskRuleInput["assigneeMode"],
      assigneeRole: String(formData.get("assigneeRole") ?? "") || null,
      assigneeUserId: String(formData.get("assigneeUserId") ?? "") || null,
      isActive: formData.get("isActive") === "on",
    };
    if (ruleId && !z.string().uuid().safeParse(ruleId).success) return fail("invalid_input");
    await ctx.run((tx) => saveTaskRule(svc(ctx, tx), input, ruleId ?? undefined));
    revalidatePath(`/t/${slug}/tasks/rules`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deleteTaskRuleAction(slug: string, ruleId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "tasks");
    if (!z.string().uuid().safeParse(ruleId).success) return fail("invalid_input");
    await ctx.run((tx) => deleteTaskRule(svc(ctx, tx), ruleId));
    revalidatePath(`/t/${slug}/tasks/rules`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function restoreDefaultRulesAction(slug: string): Promise<ActionResult<{ created: number }>> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "tasks");
    const created = await ctx.run((tx) => ensureDefaultTaskRules(svc(ctx, tx), ctx.tenant.defaultLocale));
    revalidatePath(`/t/${slug}/tasks/rules`);
    return ok({ created });
  } catch (e) {
    return mapError(e) as ActionResult<{ created: number }>;
  }
}
