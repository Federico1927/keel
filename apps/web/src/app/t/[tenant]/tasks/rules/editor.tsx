"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, Checkbox, Input, Label, Select, Textarea } from "@keel/ui";
import { deleteTaskRuleAction, restoreDefaultRulesAction, saveTaskRuleAction } from "@/server/actions/tasks";

export interface RuleView {
  id: string;
  key: string | null;
  entityType: string;
  statuses: string[];
  minHoursInStatus: number;
  overdueAfterHours: number | null;
  title: string;
  description: string | null;
  dueInHours: number;
  assigneeMode: string;
  assigneeRole: string | null;
  assigneeUserId: string | null;
  isActive: boolean;
}

const STATUS_NS: Record<string, string> = { order: "order_status", return: "return_status", purchase_order: "po_status" };
const MODES = ["role", "record_owner", "user", "none"] as const;

export function RulesEditor({ slug, rules, statuses, roles, people }: { slug: string; rules: RuleView[]; statuses: Record<string, string[]>; roles: string[]; people: { id: string; name: string }[] }) {
  const t = useTranslations("task_rules");
  const tt = useTranslations("tasks");
  const tAll = useTranslations();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = (entity: string, s: string) => tAll(`${STATUS_NS[entity]}.${s}`);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setEditing("new")} data-testid="new-rule">{t("new")}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => void (await restoreDefaultRulesAction(slug)))}>{t("restore_defaults")}</Button>
      </div>
      {editing === "new" && <RuleForm slug={slug} statuses={statuses} roles={roles} people={people} onDone={() => setEditing(null)} />}
      {rules.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      {rules.map((r) =>
        editing === r.id ? (
          <RuleForm key={r.id} slug={slug} rule={r} statuses={statuses} roles={roles} people={people} onDone={() => setEditing(null)} />
        ) : (
          <Card key={r.id} data-testid="task-rule">
            <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={r.isActive ? "success" : "muted"}>{r.isActive ? t("active") : t("inactive")}</Badge>
                  {r.key && <Badge variant="outline">{t("default")}</Badge>}
                  <span className="font-medium">{r.title}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("summary", { entity: tt(`entity.${r.entityType}`), statuses: r.statuses.map((s) => label(r.entityType, s)).join(", ") })}
                  {r.minHoursInStatus > 0 && ` · ${t("after_hours", { n: r.minHoursInStatus })}`}
                  {r.overdueAfterHours !== null && ` · ${t("past_due", { n: r.overdueAfterHours })}`}
                  {` · ${t(`modes.${r.assigneeMode}`)}${r.assigneeMode === "role" && r.assigneeRole ? ` (${tAll(`roles.${r.assigneeRole}`)})` : ""}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(r.id)}>{t("edit")}</Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await deleteTaskRuleAction(slug, r.id)))}>{t("delete")}</Button>
              </div>
            </CardContent>
          </Card>
        ),
      )}
    </div>
  );
}

function RuleForm({ slug, rule, statuses, roles, people, onDone }: { slug: string; rule?: RuleView; statuses: Record<string, string[]>; roles: string[]; people: { id: string; name: string }[]; onDone: () => void }) {
  const t = useTranslations("task_rules");
  const tt = useTranslations("tasks");
  const tAll = useTranslations();
  const tc = useTranslations("common");
  const [entity, setEntity] = useState(rule?.entityType ?? "return");
  const [mode, setMode] = useState(rule?.assigneeMode ?? "role");
  const [state, action, pending] = useActionState(saveTaskRuleAction.bind(null, slug, rule?.id ?? null), null);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);
  return (
    <Card>
      <CardContent className="pt-6">
        <form action={action} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rule-entity">{t("entity")}</Label>
              <Select id="rule-entity" name="entityType" value={entity} onChange={(e) => setEntity(e.target.value)}>
                {Object.keys(statuses).map((k) => (
                  <option key={k} value={k}>{tt(`entity.${k}`)}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-title">{t("task_title")}</Label>
              <Input id="rule-title" name="title" required maxLength={160} defaultValue={rule?.title} />
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("statuses")}</legend>
            <div className="flex flex-wrap gap-3" key={entity}>
              {(statuses[entity] ?? []).map((s) => (
                <Label key={s} className="flex items-center gap-1.5 text-sm font-normal">
                  <Checkbox name="statuses" value={s} defaultChecked={rule?.entityType === entity && rule.statuses.includes(s)} /> {tAll(`${STATUS_NS[entity]}.${s}`)}
                </Label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="rule-min">{t("min_hours")}</Label>
              <Input id="rule-min" name="minHoursInStatus" type="number" min={0} defaultValue={rule?.minHoursInStatus ?? 0} />
            </div>
            <div className="space-y-1">
              <Label className="flex items-center gap-1.5 font-normal"><Checkbox name="useDue" defaultChecked={rule?.overdueAfterHours != null} /> {t("use_due")}</Label>
              <Input name="overdueAfterHours" type="number" min={0} aria-label={t("overdue_after")} defaultValue={rule?.overdueAfterHours ?? 24} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-due">{t("due_in")}</Label>
              <Input id="rule-due" name="dueInHours" type="number" min={1} defaultValue={rule?.dueInHours ?? 24} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-desc">{t("task_description")}</Label>
            <Textarea id="rule-desc" name="description" rows={2} maxLength={1000} defaultValue={rule?.description ?? ""} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="rule-mode">{t("assignee_mode")}</Label>
              <Select id="rule-mode" name="assigneeMode" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => (
                  <option key={m} value={m}>{t(`modes.${m}`)}</option>
                ))}
              </Select>
            </div>
            {(mode === "role" || mode === "record_owner") && (
              <div className="space-y-1">
                <Label htmlFor="rule-role">{t("role")}</Label>
                <Select id="rule-role" name="assigneeRole" defaultValue={rule?.assigneeRole ?? "operations"}>
                  {roles.map((r) => (
                    <option key={r} value={r}>{tAll(`roles.${r}`)}</option>
                  ))}
                </Select>
              </div>
            )}
            {mode === "user" && (
              <div className="space-y-1">
                <Label htmlFor="rule-user">{t("user")}</Label>
                <Select id="rule-user" name="assigneeUserId" defaultValue={rule?.assigneeUserId ?? people[0]?.id}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </div>
            )}
            <Label className="flex items-center gap-2 self-end pb-2 text-sm font-normal">
              <Checkbox name="isActive" defaultChecked={rule?.isActive ?? true} /> {t("active")}
            </Label>
          </div>
          {state && !state.ok && (
            <Alert variant="destructive">
              <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onDone}>{tc("cancel")}</Button>
            <Button type="submit" disabled={pending}>{t("save")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
