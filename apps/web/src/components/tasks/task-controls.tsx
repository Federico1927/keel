"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@keel/ui";
import { createTaskAction, updateTaskAction } from "@/server/actions/tasks";

export interface PersonOption {
  id: string;
  name: string;
}

/** Status buttons and assignee picker of one task. */
export function TaskActions({ slug, taskId, status, assigneeId, people, compact = false }: { slug: string; taskId: string; status: string; assigneeId: string | null; people: PersonOption[]; compact?: boolean }) {
  const t = useTranslations("tasks");
  const [pending, start] = useTransition();
  const patch = (p: { status?: string; assigneeId?: string | null }) => start(async () => void (await updateTaskAction(slug, taskId, p)));
  const open = status === "open" || status === "in_progress";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!compact && (
        <Select aria-label={t("fields.assignee")} className="h-8 w-40 text-xs" value={assigneeId ?? ""} disabled={pending} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
          <option value="">{t("unassigned")}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      )}
      {status === "open" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => patch({ status: "in_progress" })}>{t("actions.start")}</Button>}
      {open && <Button size="sm" variant="outline" disabled={pending} onClick={() => patch({ status: "done" })} data-testid="task-done">{t("actions.done")}</Button>}
      {!open && <Button size="sm" variant="ghost" disabled={pending} onClick={() => patch({ status: "open" })}>{t("actions.reopen")}</Button>}
    </div>
  );
}

/** New task dialog; with `record` the task is linked to that record. */
export function NewTaskButton({ slug, people, record, defaultAssignee, label }: { slug: string; people: PersonOption[]; record?: { type: string; id: string; label: string }; defaultAssignee?: string; label?: string }) {
  const t = useTranslations("tasks");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createTaskAction.bind(null, slug), null);
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state]);
  return (
    <>
      <Button size="sm" variant={record ? "outline" : "default"} onClick={() => setOpen(true)} data-testid="new-task">
        <Plus className="h-4 w-4" /> {label ?? t("new")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("new")}{record ? ` · ${record.label}` : ""}</DialogTitle>
          </DialogHeader>
          <form action={action} className="space-y-3">
            {record && (
              <>
                <input type="hidden" name="entityType" value={record.type} />
                <input type="hidden" name="entityId" value={record.id} />
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="task-title">{t("fields.title")}</Label>
              <Input id="task-title" name="title" required maxLength={160} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-description">{t("fields.description")}</Label>
              <Textarea id="task-description" name="description" rows={3} maxLength={2000} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="task-assignee">{t("fields.assignee")}</Label>
                <Select id="task-assignee" name="assigneeId" defaultValue={defaultAssignee ?? ""}>
                  <option value="">{t("unassigned")}</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-due">{t("fields.due")}</Label>
                <Input id="task-due" name="dueAt" type="datetime-local" />
              </div>
            </div>
            {state && !state.ok && (
              <Alert variant="destructive">
                <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>{t("create")}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
