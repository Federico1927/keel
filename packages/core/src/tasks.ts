import { z } from "zod";
import { ORDER_STATUSES, PURCHASE_ORDER_STATUSES, RETURN_STATUSES } from "./domain";

/** Records a staff task can be linked to. Rules work on the first three; products take manual tasks. */
export const TASK_ENTITY_TYPES = ["order", "return", "purchase_order", "product"] as const;
export type TaskEntityType = (typeof TASK_ENTITY_TYPES)[number];
export const TASK_RULE_ENTITY_TYPES = ["order", "return", "purchase_order"] as const;
export type TaskRuleEntityType = (typeof TASK_RULE_ENTITY_TYPES)[number];

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_OPEN_STATUSES: readonly TaskStatus[] = ["open", "in_progress"];
export function isTaskOpen(status: string): boolean {
  return (TASK_OPEN_STATUSES as readonly string[]).includes(status);
}

/** Statuses a rule can watch, per record type. */
export const TASK_RULE_STATUSES: Record<TaskRuleEntityType, readonly string[]> = {
  order: ORDER_STATUSES,
  return: RETURN_STATUSES,
  purchase_order: PURCHASE_ORDER_STATUSES,
};

export const ASSIGNEE_MODES = ["role", "record_owner", "user", "none"] as const;

/** Tenant-configurable rule: when a record sits in one of `statuses` (optionally for a while, or past its due date), open a task; close it when the record moves on. */
export const taskRuleSchema = z
  .object({
    entityType: z.enum(TASK_RULE_ENTITY_TYPES),
    statuses: z.array(z.string().min(1).max(40)).min(1).max(12),
    /** Only after the record has been in the status this long. */
    minHoursInStatus: z.number().int().min(0).max(24 * 365).default(0),
    /** Only when the record's own due date (a PO's expected date) has passed by this many hours; null = ignore due dates. */
    overdueAfterHours: z.number().int().min(0).max(24 * 365).nullable().default(null),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable().default(null),
    dueInHours: z.number().int().min(1).max(24 * 90).default(24),
    assigneeMode: z.enum(ASSIGNEE_MODES).default("role"),
    assigneeRole: z.string().max(40).nullable().default(null),
    assigneeUserId: z.string().uuid().nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    const allowed = TASK_RULE_STATUSES[r.entityType];
    for (const s of r.statuses) if (!allowed.includes(s)) ctx.addIssue({ code: "custom", path: ["statuses"], message: `unknown status ${s}` });
    if (r.assigneeMode === "role" && !r.assigneeRole) ctx.addIssue({ code: "custom", path: ["assigneeRole"], message: "role required" });
    if (r.assigneeMode === "user" && !r.assigneeUserId) ctx.addIssue({ code: "custom", path: ["assigneeUserId"], message: "user required" });
  });
export type TaskRuleInput = z.input<typeof taskRuleSchema>;
export type TaskRuleConfig = z.output<typeof taskRuleSchema>;

export interface TaskRule extends Pick<TaskRuleConfig, "entityType" | "statuses" | "minHoursInStatus" | "overdueAfterHours" | "isActive"> {
  id: string;
}

/** What a rule needs to know about a record. `episode` changes whenever the record enters a status again (or its due date moves). */
export interface TaskRecordState {
  entityType: TaskEntityType;
  entityId: string;
  status: string;
  statusSince: Date | null;
  dueAt: Date | null;
  episode: string;
}

export interface ExistingRuleTask {
  id: string;
  ruleId: string | null;
  status: string;
  episode: string | null;
}

export function taskRuleMatches(rule: TaskRule, rec: TaskRecordState, now: Date): boolean {
  if (!rule.isActive || rule.entityType !== rec.entityType) return false;
  if (!rule.statuses.includes(rec.status)) return false;
  if (rule.minHoursInStatus > 0) {
    if (!rec.statusSince) return false;
    if (now.getTime() - rec.statusSince.getTime() < rule.minHoursInStatus * 3600e3) return false;
  }
  if (rule.overdueAfterHours !== null) {
    if (!rec.dueAt) return false;
    if (now.getTime() - rec.dueAt.getTime() < rule.overdueAfterHours * 3600e3) return false;
  }
  return true;
}

/**
 * What to do with one record: a rule that matches opens a task unless one is already open for it
 * or one was already opened in this episode (so a task closed by hand is not reopened while the
 * record stays put); open tasks of rules that no longer match are closed automatically.
 */
export function planTaskChanges(rules: readonly TaskRule[], rec: TaskRecordState, existing: readonly ExistingRuleTask[], now: Date): { create: string[]; close: string[] } {
  const create: string[] = [];
  const close: string[] = [];
  for (const rule of rules) {
    if (rule.entityType !== rec.entityType) continue;
    const mine = existing.filter((t) => t.ruleId === rule.id);
    if (taskRuleMatches(rule, rec, now)) {
      if (!mine.some((t) => isTaskOpen(t.status) || t.episode === rec.episode)) create.push(rule.id);
    } else {
      for (const t of mine) if (isTaskOpen(t.status)) close.push(t.id);
    }
  }
  return { create, close };
}

/** Least-loaded candidate (ties: first in the given order, which callers keep stable). */
export function pickAssignee(candidates: readonly { userId: string; openTasks: number }[]): string | null {
  let best: { userId: string; openTasks: number } | null = null;
  for (const c of candidates) if (!best || c.openTasks < best.openTasks) best = c;
  return best?.userId ?? null;
}

export function isTaskOverdue(task: { status: string; dueAt: Date | null }, now: Date): boolean {
  return isTaskOpen(task.status) && task.dueAt !== null && task.dueAt.getTime() < now.getTime();
}

type L = Record<"en" | "it" | "es", string>;
/** Default rules every tenant starts with (titles in the tenant's language; tenants edit or switch them off). */
export const DEFAULT_TASK_RULES: { key: string; rule: Omit<TaskRuleConfig, "title" | "description">; title: L; description: L }[] = [
  {
    key: "return_received_inspect",
    rule: { entityType: "return", statuses: ["received"], minHoursInStatus: 0, overdueAfterHours: null, dueInHours: 48, assigneeMode: "role", assigneeRole: "operations", assigneeUserId: null, isActive: true },
    title: { en: "Inspect the returned items", it: "Ispeziona gli articoli resi", es: "Inspecciona los artículos devueltos" },
    description: { en: "Check condition, record the inspection outcome and decide the refund.", it: "Controlla lo stato, registra l'esito dell'ispezione e decidi il rimborso.", es: "Comprueba el estado, registra el resultado de la inspección y decide el reembolso." },
  },
  {
    key: "po_overdue_follow_up",
    rule: { entityType: "purchase_order", statuses: ["sent", "confirmed", "in_transit", "partially_received"], minHoursInStatus: 0, overdueAfterHours: 24, dueInHours: 24, assigneeMode: "record_owner", assigneeRole: "operations", assigneeUserId: null, isActive: true },
    title: { en: "Follow up with the supplier on the late delivery", it: "Sollecita il fornitore per la consegna in ritardo", es: "Contacta al proveedor por la entrega retrasada" },
    description: { en: "The expected date has passed: ask for a new date and update the PO.", it: "La data prevista è passata: chiedi una nuova data e aggiorna l'ordine d'acquisto.", es: "La fecha prevista ha pasado: pide una nueva fecha y actualiza la orden de compra." },
  },
  {
    key: "order_on_hold_review",
    rule: { entityType: "order", statuses: ["on_hold"], minHoursInStatus: 72, overdueAfterHours: null, dueInHours: 24, assigneeMode: "role", assigneeRole: "customer_care", assigneeUserId: null, isActive: true },
    title: { en: "Review the order on hold", it: "Rivedi l'ordine in sospeso", es: "Revisa el pedido en espera" },
    description: { en: "On hold for more than 3 days: release it, contact the customer or cancel.", it: "In sospeso da più di 3 giorni: sbloccalo, contatta il cliente o annullalo.", es: "En espera desde hace más de 3 días: libéralo, contacta al cliente o cancélalo." },
  },
];

export function localizedDefault(l: L, locale: string): string {
  return l[(locale in l ? locale : "en") as keyof L];
}
