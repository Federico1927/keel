import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { TENANT_ROLES, canDo } from "@hullwise/config";
import { TASK_RULE_STATUSES } from "@hullwise/core";
import { listTaskRules } from "@hullwise/services";
import { PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { tenantPeople } from "@/server/people";
import { RulesEditor } from "./editor";

export default async function TaskRulesPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "tasks");
  if (!canDo(ctx.role, "manage_settings")) notFound();
  const t = await getTranslations("task_rules");
  const tt = await getTranslations("tasks");
  const [rules, people] = await Promise.all([ctx.run((tx) => listTaskRules({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } })), tenantPeople(ctx)]);
  return (
    <>
      <Link href={`/t/${tenant}/tasks`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" /> {tt("title")}</Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <RulesEditor
        slug={tenant}
        statuses={Object.fromEntries(Object.entries(TASK_RULE_STATUSES).map(([k, v]) => [k, [...v]]))}
        roles={[...TENANT_ROLES]}
        people={people.map((p) => ({ id: p.id, name: p.name }))}
        rules={rules.map((r) => ({ id: r.id, key: r.key, entityType: r.entityType, statuses: r.statuses, minHoursInStatus: r.minHoursInStatus, overdueAfterHours: r.overdueAfterHours, title: r.title, description: r.description, dueInHours: r.dueInHours, assigneeMode: r.assigneeMode, assigneeRole: r.assigneeRole, assigneeUserId: r.assigneeUserId, isActive: r.isActive }))}
      />
    </>
  );
}
