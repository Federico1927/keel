import { and, asc, desc, eq, inArray, isNull, recordAudit, schema, sql, type SQL } from "@hullwise/db";
import { DEFAULT_TASK_RULES, INCOMING_PO_STATUSES, TASK_OPEN_STATUSES, isTaskOpen, localizedDefault, pickAssignee, planTaskChanges, taskRuleSchema, type TaskEntityType, type TaskRecordState, type TaskRule, type TaskRuleEntityType, type TaskRuleInput, type TaskStatus } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";

export class TaskError extends Error {
  constructor(public code: "not_found" | "invalid_input" | "forbidden") {
    super(code);
    this.name = "TaskError";
  }
}

/* ---------- records ---------- */

export interface RecordRef {
  entityType: TaskEntityType;
  entityId: string;
  label: string;
  /** Tenant-relative link. */
  link: string;
  /** Who owns the record (PO creator, order assignee), used by `record_owner` rules. */
  ownerId: string | null;
}

/** Label, link and owner of a record; null when it does not exist in this tenant. */
export async function recordRef(ctx: ServiceContext, entityType: TaskEntityType, entityId: string): Promise<RecordRef | null> {
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) return null;
  if (entityType === "order") {
    const [o] = await ctx.tx.select({ name: schema.orders.name, assignedTo: schema.orders.assignedTo }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, entityId))).limit(1);
    return o ? { entityType, entityId, label: o.name, link: `/orders/${entityId}`, ownerId: o.assignedTo } : null;
  }
  if (entityType === "return") {
    const [r] = await ctx.tx.select({ number: schema.returnRequests.number, createdBy: schema.returnRequests.createdBy }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, entityId))).limit(1);
    return r ? { entityType, entityId, label: `R-${r.number}`, link: `/returns/${entityId}`, ownerId: r.createdBy } : null;
  }
  if (entityType === "purchase_order") {
    const [p] = await ctx.tx.select({ number: schema.purchaseOrders.number, createdBy: schema.purchaseOrders.createdBy }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, entityId))).limit(1);
    return p ? { entityType, entityId, label: p.number, link: `/purchasing/${entityId}`, ownerId: p.createdBy } : null;
  }
  const [p] = await ctx.tx.select({ title: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, entityId))).limit(1);
  return p ? { entityType: "product", entityId, label: p.title, link: `/products/${entityId}`, ownerId: null } : null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

/** Record state for the rule engine; the episode changes when the record (re)enters a status or its due date moves. */
async function recordStates(ctx: ServiceContext, entityType: TaskRuleEntityType, ids: string[]): Promise<TaskRecordState[]> {
  if (!ids.length) return [];
  if (entityType === "order") {
    const rows = await ctx.tx.select({ id: schema.orders.id, status: schema.orders.status, since: schema.orders.statusChangedAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, ids)));
    return rows.map((r) => ({ entityType, entityId: r.id, status: r.status, statusSince: r.since, dueAt: null, episode: `${r.status}:${iso(r.since)}` }));
  }
  if (entityType === "return") {
    const rows = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), inArray(schema.returnRequests.id, ids)));
    return rows.map((r) => {
      const since = r.status === "requested" ? r.requestedAt : r.status === "approved" ? r.approvedAt : r.status === "received" ? r.receivedAt : r.closedAt;
      return { entityType, entityId: r.id, status: r.status, statusSince: since ?? r.updatedAt, dueAt: null, episode: `${r.status}:${iso(since)}` };
    });
  }
  const rows = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), inArray(schema.purchaseOrders.id, ids)));
  return rows.map((r) => {
    const since = r.status === "sent" ? r.sentAt : r.status === "confirmed" ? r.confirmedAt : r.status === "received" ? r.receivedAt : r.status === "cancelled" ? r.cancelledAt : null;
    return { entityType: "purchase_order" as const, entityId: r.id, status: r.status, statusSince: since ?? r.updatedAt, dueAt: r.expectedAt, episode: `${INCOMING_PO_STATUSES.includes(r.status as never) || r.status === "sent" ? "open" : r.status}:${iso(r.expectedAt)}` };
  });
}

/* ---------- rules ---------- */

export async function listTaskRules(ctx: ServiceContext) {
  return ctx.tx.select().from(schema.taskRules).where(eq(schema.taskRules.tenantId, ctx.tenantId)).orderBy(asc(schema.taskRules.entityType), asc(schema.taskRules.createdAt));
}

async function activeRules(ctx: ServiceContext, entityType?: TaskRuleEntityType) {
  const conds: SQL[] = [eq(schema.taskRules.tenantId, ctx.tenantId), eq(schema.taskRules.isActive, true)];
  if (entityType) conds.push(eq(schema.taskRules.entityType, entityType));
  return ctx.tx.select().from(schema.taskRules).where(and(...conds));
}
const asRule = (r: typeof schema.taskRules.$inferSelect): TaskRule => ({ id: r.id, entityType: r.entityType as TaskRuleEntityType, statuses: r.statuses, minHoursInStatus: r.minHoursInStatus, overdueAfterHours: r.overdueAfterHours, isActive: r.isActive });

/** Creates the default rules the tenant does not have yet (by key), titles in the tenant's language. */
export async function ensureDefaultTaskRules(ctx: ServiceContext, locale: string): Promise<number> {
  const existing = new Set((await ctx.tx.select({ key: schema.taskRules.key }).from(schema.taskRules).where(eq(schema.taskRules.tenantId, ctx.tenantId))).map((r) => r.key));
  let n = 0;
  for (const d of DEFAULT_TASK_RULES) {
    if (existing.has(d.key)) continue;
    await ctx.tx.insert(schema.taskRules).values({ tenantId: ctx.tenantId, key: d.key, ...d.rule, title: localizedDefault(d.title, locale), description: localizedDefault(d.description, locale), createdBy: ctx.actor.userId });
    n++;
  }
  return n;
}

export async function saveTaskRule(ctx: ServiceContext, input: TaskRuleInput, ruleId?: string): Promise<string> {
  const parsed = taskRuleSchema.safeParse(input);
  if (!parsed.success) throw new TaskError("invalid_input");
  const v = parsed.data;
  const now = ctx.now ?? new Date();
  if (ruleId) {
    const [before] = await ctx.tx.select().from(schema.taskRules).where(and(eq(schema.taskRules.tenantId, ctx.tenantId), eq(schema.taskRules.id, ruleId))).limit(1);
    if (!before) throw new TaskError("not_found");
    await ctx.tx.update(schema.taskRules).set({ ...v, updatedAt: now }).where(eq(schema.taskRules.id, ruleId));
    const diff = Object.fromEntries(Object.entries(v).filter(([k, val]) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(val)).map(([k, val]) => [k, { from: before[k as keyof typeof before], to: val }]));
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "task_rule.updated", entityType: "task_rule", entityId: ruleId, diff });
    return ruleId;
  }
  const [row] = await ctx.tx.insert(schema.taskRules).values({ tenantId: ctx.tenantId, ...v, createdBy: ctx.actor.userId }).returning({ id: schema.taskRules.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "task_rule.created", entityType: "task_rule", entityId: row!.id, metadata: { entityType: v.entityType, statuses: v.statuses, title: v.title } });
  return row!.id;
}

export async function deleteTaskRule(ctx: ServiceContext, ruleId: string): Promise<boolean> {
  const [row] = await ctx.tx.delete(schema.taskRules).where(and(eq(schema.taskRules.tenantId, ctx.tenantId), eq(schema.taskRules.id, ruleId))).returning();
  if (row) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "task_rule.deleted", entityType: "task_rule", entityId: ruleId, metadata: { title: row.title, key: row.key } });
  return Boolean(row);
}

/* ---------- assignment ---------- */

async function resolveAssignee(ctx: ServiceContext, rule: typeof schema.taskRules.$inferSelect, ref: RecordRef): Promise<string | null> {
  const members = await ctx.tx.select({ userId: schema.tenantMemberships.userId, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true))).orderBy(asc(schema.tenantMemberships.createdAt));
  const isMember = (id: string | null) => Boolean(id && members.some((m) => m.userId === id));
  if (rule.assigneeMode === "none") return null;
  if (rule.assigneeMode === "user") return isMember(rule.assigneeUserId) ? rule.assigneeUserId : null;
  if (rule.assigneeMode === "record_owner" && isMember(ref.ownerId)) return ref.ownerId;
  const role = rule.assigneeRole ?? "operations";
  let pool = members.filter((m) => m.role === role);
  if (!pool.length) pool = members.filter((m) => m.role === "admin" || m.role === "owner");
  if (!pool.length) return null;
  const load = await ctx.tx.select({ userId: schema.tasks.assigneeId, n: sql<number>`count(*)::int` }).from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), inArray(schema.tasks.status, [...TASK_OPEN_STATUSES]), inArray(schema.tasks.assigneeId, pool.map((p) => p.userId)))).groupBy(schema.tasks.assigneeId);
  return pickAssignee(pool.map((p) => ({ userId: p.userId, openTasks: load.find((l) => l.userId === p.userId)?.n ?? 0 })));
}

/* ---------- applying rules ---------- */

async function notifyAssignee(ctx: ServiceContext, task: { id: string; title: string; assigneeId: string | null; entityLabel: string | null; link: string | null }) {
  if (!task.assigneeId || task.assigneeId === ctx.actor.userId) return;
  await notifyUsers(ctx, { userIds: [task.assigneeId], type: "task_assigned", title: task.title, body: task.entityLabel, link: task.link ?? "/tasks", metadata: { taskId: task.id } });
}

/**
 * Applies the tenant's task rules to records of one type: opens the tasks whose rule matches and
 * closes (closed_reason `auto`) the open ones whose record moved on. Called by the services that
 * change returns and purchase orders, and by the `tasks` tick for time-based rules and orders.
 */
export async function syncRecordTasks(ctx: ServiceContext, entityType: TaskRuleEntityType, entityIds: string[]): Promise<{ created: number; closed: number }> {
  // a rule switched off leaves its open tasks alone; only active rules open and close tasks
  const rules = await activeRules(ctx, entityType);
  const ruleIds = rules.map((r) => r.id);
  if (!entityIds.length || !rules.length) return { created: 0, closed: 0 };
  const states = await recordStates(ctx, entityType, entityIds);
  const existing = await ctx.tx.select({ id: schema.tasks.id, ruleId: schema.tasks.ruleId, status: schema.tasks.status, episode: schema.tasks.episode, entityId: schema.tasks.entityId, title: schema.tasks.title }).from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), eq(schema.tasks.entityType, entityType), inArray(schema.tasks.entityId, entityIds), inArray(schema.tasks.ruleId, ruleIds)));
  const now = ctx.now ?? new Date();
  const allRules: TaskRule[] = rules.map(asRule);
  let created = 0;
  let closed = 0;
  for (const st of states) {
    const plan = planTaskChanges(allRules, st, existing.filter((t) => t.entityId === st.entityId), now);
    if (plan.close.length) {
      const rows = await ctx.tx.update(schema.tasks).set({ status: "done", closedReason: "auto", completedAt: now, completedBy: null, updatedAt: now }).where(and(eq(schema.tasks.tenantId, ctx.tenantId), inArray(schema.tasks.id, plan.close))).returning({ id: schema.tasks.id });
      for (const r of rows) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", action: "task.auto_closed", entityType: "task", entityId: r.id, diff: { status: { from: "open", to: "done" } }, metadata: { recordType: entityType, recordId: st.entityId, recordStatus: st.status } });
      closed += rows.length;
    }
    if (!plan.create.length) continue;
    const ref = await recordRef(ctx, entityType, st.entityId);
    if (!ref) continue;
    for (const ruleId of plan.create) {
      const rule = rules.find((r) => r.id === ruleId)!;
      const assigneeId = await resolveAssignee(ctx, rule, ref);
      const [task] = await ctx.tx.insert(schema.tasks).values({ tenantId: ctx.tenantId, entityType, entityId: st.entityId, entityLabel: ref.label, title: rule.title, description: rule.description, status: "open", assigneeId, dueAt: new Date(now.getTime() + rule.dueInHours * 3600e3), ruleId, episode: st.episode, createdBy: null, createdAt: now, updatedAt: now }).returning({ id: schema.tasks.id });
      await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "task.created_by_rule", entityType: "task", entityId: task!.id, diff: { status: { from: null, to: "open" }, assigneeId: { from: null, to: assigneeId } }, metadata: { ruleId, recordType: entityType, recordId: st.entityId, recordStatus: st.status } });
      await notifyAssignee({ ...ctx, actor: { type: "system", userId: null } }, { id: task!.id, title: rule.title, assigneeId, entityLabel: ref.label, link: ref.link });
      created++;
    }
  }
  return { created, closed };
}

/**
 * Periodic sweep (tick `tasks`): candidate records of each rule (time-based rules need it, and
 * orders change status in many places) plus every record with an open rule task, so closure
 * never depends on a hook.
 */
export async function sweepTaskRules(ctx: ServiceContext): Promise<{ created: number; closed: number }> {
  const rules = await activeRules(ctx);
  const out = { created: 0, closed: 0 };
  for (const entityType of ["order", "return", "purchase_order"] as const) {
    const mine = rules.filter((r) => r.entityType === entityType);
    const statuses = [...new Set(mine.flatMap((r) => r.statuses))];
    const ids = new Set<string>();
    if (statuses.length) {
      const table = entityType === "order" ? schema.orders : entityType === "return" ? schema.returnRequests : schema.purchaseOrders;
      const rows = await ctx.tx.select({ id: table.id }).from(table).where(and(eq(table.tenantId, ctx.tenantId), inArray(table.status, statuses))).limit(2000);
      for (const r of rows) ids.add(r.id);
    }
    const open = await ctx.tx.selectDistinct({ id: schema.tasks.entityId }).from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), eq(schema.tasks.entityType, entityType), inArray(schema.tasks.status, [...TASK_OPEN_STATUSES]), sql`${schema.tasks.ruleId} is not null`));
    for (const r of open) if (r.id) ids.add(r.id);
    const list = [...ids];
    for (let i = 0; i < list.length; i += 500) {
      const r = await syncRecordTasks(ctx, entityType, list.slice(i, i + 500));
      out.created += r.created;
      out.closed += r.closed;
    }
  }
  return out;
}

/** Reminds assignees of open tasks past their due date (once a day per task). */
export async function remindOverdueTasks(ctx: ServiceContext): Promise<number> {
  const now = ctx.now ?? new Date();
  const due = await ctx.tx.select().from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), inArray(schema.tasks.status, [...TASK_OPEN_STATUSES]), sql`${schema.tasks.dueAt} < ${now}`, sql`${schema.tasks.assigneeId} is not null`)).limit(500);
  let n = 0;
  for (const t of due) n += await notifyUsers({ ...ctx, actor: { type: "system", userId: null } }, { userIds: [t.assigneeId!], type: "task_due", title: t.title, body: t.entityLabel, link: `/tasks?task=${t.id}`, severity: "warning", metadata: { taskId: t.id }, antiSpamMinutes: 24 * 60 });
  return n;
}

/* ---------- manual tasks ---------- */

export interface TaskInput {
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  dueAt?: Date | null;
  entityType?: TaskEntityType | null;
  entityId?: string | null;
}

async function assertMember(ctx: ServiceContext, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = await ctx.tx.select({ id: schema.tenantMemberships.id }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
  if (!m) throw new TaskError("invalid_input");
}

export async function createTask(ctx: ServiceContext, input: TaskInput): Promise<string> {
  const title = input.title.trim();
  if (!title || title.length > 160 || (input.description?.length ?? 0) > 2000) throw new TaskError("invalid_input");
  await assertMember(ctx, input.assigneeId);
  let ref: RecordRef | null = null;
  if (input.entityType && input.entityId) {
    ref = await recordRef(ctx, input.entityType, input.entityId);
    if (!ref) throw new TaskError("not_found");
  }
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx.insert(schema.tasks).values({ tenantId: ctx.tenantId, entityType: ref?.entityType ?? null, entityId: ref?.entityId ?? null, entityLabel: ref?.label ?? null, title, description: input.description?.trim() || null, assigneeId: input.assigneeId ?? null, dueAt: input.dueAt ?? null, createdBy: ctx.actor.userId, createdAt: now, updatedAt: now }).returning({ id: schema.tasks.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "task.created", entityType: "task", entityId: row!.id, diff: { status: { from: null, to: "open" }, assigneeId: { from: null, to: input.assigneeId ?? null } }, metadata: { title, record: ref ? `${ref.entityType}:${ref.entityId}` : null } });
  await notifyAssignee(ctx, { id: row!.id, title, assigneeId: input.assigneeId ?? null, entityLabel: ref?.label ?? null, link: ref?.link ?? `/tasks?task=${row!.id}` });
  return row!.id;
}

export async function updateTask(ctx: ServiceContext, taskId: string, patch: { status?: TaskStatus; assigneeId?: string | null; dueAt?: Date | null; title?: string; description?: string | null }): Promise<void> {
  const [before] = await ctx.tx.select().from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), eq(schema.tasks.id, taskId))).limit(1);
  if (!before) throw new TaskError("not_found");
  if (patch.assigneeId !== undefined) await assertMember(ctx, patch.assigneeId);
  if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 160)) throw new TaskError("invalid_input");
  const now = ctx.now ?? new Date();
  const set: Partial<typeof schema.tasks.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
  if (patch.status !== undefined && patch.status !== before.status) {
    set.status = patch.status;
    if (isTaskOpen(patch.status)) Object.assign(set, { completedAt: null, completedBy: null, closedReason: null });
    else Object.assign(set, { completedAt: now, completedBy: ctx.actor.userId, closedReason: patch.status });
  }
  await ctx.tx.update(schema.tasks).set(set).where(eq(schema.tasks.id, taskId));
  const diff = Object.fromEntries((["status", "assigneeId", "dueAt", "title", "description"] as const).filter((k) => k in set && JSON.stringify(set[k]) !== JSON.stringify(before[k])).map((k) => [k, { from: before[k], to: set[k] }]));
  if (Object.keys(diff).length) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "task.updated", entityType: "task", entityId: taskId, diff });
  if (patch.assigneeId && patch.assigneeId !== before.assigneeId) await notifyAssignee(ctx, { id: taskId, title: set.title ?? before.title, assigneeId: patch.assigneeId, entityLabel: before.entityLabel, link: before.entityType && before.entityId ? `/${before.entityType === "purchase_order" ? "purchasing" : before.entityType === "return" ? "returns" : `${before.entityType}s`}/${before.entityId}` : `/tasks?task=${taskId}` });
}

export interface TaskFilters {
  scope?: "mine" | "all" | "unassigned";
  status?: "open" | "closed" | "overdue" | "all";
  entityType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** "My tasks" and the team list, with server-side filters and pagination. */
export async function listTasks(ctx: ServiceContext, userId: string, f: TaskFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(100, f.pageSize ?? 30);
  const now = ctx.now ?? new Date();
  const base: SQL[] = [eq(schema.tasks.tenantId, ctx.tenantId)];
  if (f.entityType) base.push(eq(schema.tasks.entityType, f.entityType));
  if (f.q?.trim()) base.push(sql`(${schema.tasks.title} ilike ${`%${f.q.trim()}%`} or ${schema.tasks.entityLabel} ilike ${`%${f.q.trim()}%`})`);
  const scope = f.scope ?? "mine";
  if (scope === "mine") base.push(eq(schema.tasks.assigneeId, userId));
  if (scope === "unassigned") base.push(isNull(schema.tasks.assigneeId));
  const conds = [...base];
  const status = f.status ?? "open";
  if (status === "open") conds.push(inArray(schema.tasks.status, [...TASK_OPEN_STATUSES]));
  if (status === "closed") conds.push(sql`${schema.tasks.status} not in ('open','in_progress')`);
  if (status === "overdue") conds.push(inArray(schema.tasks.status, [...TASK_OPEN_STATUSES]), sql`${schema.tasks.dueAt} < ${now}`);
  const where = and(...conds);
  const [rows, [count], [counts]] = await Promise.all([
    ctx.tx.select({ t: schema.tasks, assigneeName: schema.users.name, assigneeEmail: schema.users.email }).from(schema.tasks).leftJoin(schema.users, eq(schema.users.id, schema.tasks.assigneeId)).where(where).orderBy(sql`case when ${schema.tasks.status} in ('open','in_progress') then 0 else 1 end`, sql`${schema.tasks.dueAt} asc nulls last`, desc(schema.tasks.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(where),
    ctx.tx.select({ open: sql<number>`count(*) filter (where ${schema.tasks.status} in ('open','in_progress'))::int`, overdue: sql<number>`count(*) filter (where ${schema.tasks.status} in ('open','in_progress') and ${schema.tasks.dueAt} < ${now})::int`, closed: sql<number>`count(*) filter (where ${schema.tasks.status} not in ('open','in_progress'))::int` }).from(schema.tasks).where(and(...base)),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize, counts: counts ?? { open: 0, overdue: 0, closed: 0 } };
}

/** Tasks shown on a record page, open first. */
export async function tasksForRecord(ctx: ServiceContext, entityType: TaskEntityType, entityId: string) {
  return ctx.tx.select({ t: schema.tasks, assigneeName: schema.users.name, assigneeEmail: schema.users.email }).from(schema.tasks).leftJoin(schema.users, eq(schema.users.id, schema.tasks.assigneeId)).where(and(eq(schema.tasks.tenantId, ctx.tenantId), eq(schema.tasks.entityType, entityType), eq(schema.tasks.entityId, entityId))).orderBy(sql`case when ${schema.tasks.status} in ('open','in_progress') then 0 else 1 end`, desc(schema.tasks.createdAt)).limit(50);
}

export async function openTaskCount(ctx: ServiceContext, userId: string): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(and(eq(schema.tasks.tenantId, ctx.tenantId), eq(schema.tasks.assigneeId, userId), inArray(schema.tasks.status, [...TASK_OPEN_STATUSES])));
  return r?.n ?? 0;
}
