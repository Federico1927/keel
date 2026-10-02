import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canViewPage, canWritePage } from "@hullwise/config";
import { formatDateTime, isTaskOverdue, type TaskEntityType } from "@hullwise/core";
import { tasksForRecord } from "@hullwise/services";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@hullwise/ui";
import { getTenantContext } from "@/server/tenant";
import { tenantPeople } from "@/server/people";
import { NewTaskButton, TaskActions } from "./tasks/task-controls";

const STATUS_VARIANT: Record<string, "info" | "warning" | "success" | "muted"> = { open: "info", in_progress: "warning", done: "success", cancelled: "muted" };

/**
 * "Tasks for this record" card for record pages (order, return, purchase order, product). Self-contained:
 * one line in the page's aside, `<RecordTasks slug={tenant} type="return" id={r.id} label="R-12" />`.
 */
export async function RecordTasks({ slug, type, id, label }: { slug: string; type: TaskEntityType; id: string; label: string }) {
  const ctx = await getTenantContext(slug);
  if (!canViewPage(ctx.role, "tasks")) return null;
  const t = await getTranslations("tasks");
  const [rows, people] = await Promise.all([ctx.run((tx) => tasksForRecord({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, type, id)), tenantPeople(ctx)]);
  const canWrite = canWritePage(ctx.role, "tasks");
  const now = new Date();
  const options = people.map((p) => ({ id: p.id, name: p.name }));
  return (
    <Card data-testid="record-tasks">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{t("panel.title")}</CardTitle>
        {canWrite && <NewTaskButton slug={slug} people={options} record={{ type, id, label }} defaultAssignee={ctx.user.id} label={t("panel.add")} />}
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("panel.empty")}</p>}
        {rows.map(({ t: task, assigneeName, assigneeEmail }) => (
          <div key={task.id} className="space-y-1.5 rounded-md border p-2.5 text-sm" data-testid="record-task">
            <div className="flex items-start justify-between gap-2">
              <p className={task.status === "done" || task.status === "cancelled" ? "text-muted-foreground line-through" : "font-medium"}>{task.title}</p>
              <Badge variant={isTaskOverdue(task, now) ? "destructive" : (STATUS_VARIANT[task.status] ?? "muted")} data-testid="record-task-status">{isTaskOverdue(task, now) ? t("overdue") : t(`statuses.${task.status}`)}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {assigneeName ?? assigneeEmail ?? t("unassigned")}
              {task.dueAt && ` · ${formatDateTime(task.dueAt, ctx.locale, ctx.tenant.timezone)}`}
              {task.ruleId && ` · ${t("by_rule")}`}
            </p>
            {task.closedReason === "auto" && <p className="text-xs text-muted-foreground">{t("auto_closed")}</p>}
            {canWrite && <TaskActions slug={slug} taskId={task.id} status={task.status} assigneeId={task.assigneeId} people={options} compact />}
          </div>
        ))}
        <Link href={`/t/${slug}/tasks?scope=all&status=all&entity=${type}`} className="text-xs text-muted-foreground underline">{t("panel.all")}</Link>
      </CardContent>
    </Card>
  );
}
