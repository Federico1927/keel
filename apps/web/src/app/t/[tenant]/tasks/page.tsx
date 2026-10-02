import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage } from "@hullwise/config";
import { TASK_ENTITY_TYPES, formatDateTime, formatNumber, isTaskOverdue } from "@hullwise/core";
import { listTasks } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, Input, PageHeader, Pagination } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { tenantPeople } from "@/server/people";
import { NewTaskButton, TaskActions } from "@/components/tasks/task-controls";
import { Chip } from "../notifications/tabs";

const RECORD_PATH: Record<string, string> = { order: "orders", return: "returns", purchase_order: "purchasing", product: "products" };
const STATUS_VARIANT: Record<string, "info" | "warning" | "success" | "muted"> = { open: "info", in_progress: "warning", done: "success", cancelled: "muted" };

export default async function TasksPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "tasks");
  const t = await getTranslations("tasks");
  const scope = sp.scope === "all" || sp.scope === "unassigned" ? sp.scope : "mine";
  const status = sp.status === "overdue" || sp.status === "closed" || sp.status === "all" ? sp.status : "open";
  const entity = (TASK_ENTITY_TYPES as readonly string[]).includes(sp.entity ?? "") ? sp.entity : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [data, people] = await Promise.all([ctx.run((tx) => listTasks({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id, { scope, status, entityType: entity, q, page })), tenantPeople(ctx)]);
  const base = `/t/${tenant}/tasks`;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ scope: scope === "mine" ? undefined : scope, status: status === "open" ? undefined : status, entity, q, ...patch })) if (v) u.set(k, v);
    return `${base}${u.size ? `?${u}` : ""}`;
  };
  const canWrite = canWritePage(ctx.role, "tasks");
  const options = people.map((p) => ({ id: p.id, name: p.name }));
  const now = new Date();
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <>
            {canDo(ctx.role, "manage_settings") && <Link href={`${base}/rules`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="task-rules-link">{t("rules")}</Link>}
            {canWrite && <NewTaskButton slug={tenant} people={options} defaultAssignee={ctx.user.id} />}
          </>
        }
      />
      <div className="mb-2 flex flex-wrap gap-2">
        {(["mine", "all", "unassigned"] as const).map((s) => (
          <Chip key={s} href={href({ scope: s === "mine" ? undefined : s, page: undefined })} active={scope === s} testId={`scope-${s}`}>{t(`tabs.${s}`)}</Chip>
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Chip href={href({ status: undefined, page: undefined })} active={status === "open"}>{t("status_filter.open")} <span className="tabular opacity-70">{formatNumber(data.counts.open, ctx.locale)}</span></Chip>
          <Chip href={href({ status: "overdue", page: undefined })} active={status === "overdue"} testId="status-overdue">{t("status_filter.overdue")} <span className="tabular opacity-70">{formatNumber(data.counts.overdue, ctx.locale)}</span></Chip>
          <Chip href={href({ status: "closed", page: undefined })} active={status === "closed"}>{t("status_filter.closed")} <span className="tabular opacity-70">{formatNumber(data.counts.closed, ctx.locale)}</span></Chip>
          <Chip href={href({ status: "all", page: undefined })} active={status === "all"}>{t("status_filter.all")}</Chip>
        </div>
        <form action={base} className="flex gap-2">
          {scope !== "mine" && <input type="hidden" name="scope" value={scope} />}
          {status !== "open" && <input type="hidden" name="status" value={status} />}
          <Input size="sm" name="q" defaultValue={q} placeholder={t("search")} aria-label={t("search")} className="sm:w-56" />
        </form>
      </div>
      {data.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {data.rows.map(({ t: task, assigneeName, assigneeEmail }) => {
              const overdue = isTaskOverdue(task, now);
              return (
                <div key={task.id} className="flex flex-col gap-2 p-4 lg:flex-row lg:items-center" data-testid="task-row">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={overdue ? "destructive" : (STATUS_VARIANT[task.status] ?? "muted")}>{overdue ? t("overdue") : t(`statuses.${task.status}`)}</Badge>
                      <span className={task.status === "done" || task.status === "cancelled" ? "text-muted-foreground line-through" : "font-medium"}>{task.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {task.entityType && task.entityId && (
                        <>
                          {t(`entity.${task.entityType}`)}{" "}
                          <Link href={`/t/${tenant}/${RECORD_PATH[task.entityType]}/${task.entityId}`} className="underline">{task.entityLabel ?? task.entityId.slice(0, 8)}</Link>
                          {" · "}
                        </>
                      )}
                      {assigneeName ?? assigneeEmail ?? t("unassigned")}
                      {task.dueAt && ` · ${formatDateTime(task.dueAt, ctx.locale, ctx.tenant.timezone)}`}
                      {task.ruleId && ` · ${t("by_rule")}`}
                      {task.closedReason === "auto" && ` · ${t("auto_closed")}`}
                    </p>
                    {task.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{task.description}</p>}
                  </div>
                  {canWrite && <TaskActions slug={tenant} taskId={task.id} status={task.status} assigneeId={task.assigneeId} people={options} />}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => href({ page: String(p) })} summary={t("pagination", { from: data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1, to: Math.min(data.page * data.pageSize, data.total), total: data.total })} />
    </>
  );
}
