import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { eq, schema } from "@hullwise/db";
import { ORDER_STATUSES } from "@hullwise/core";
import { Button, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { previewStateRules } from "@/server/actions/state-rules";
import { StateRulesEditor } from "./editor";

export default async function OrderStatesPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("state_rules");
  const rules = await ctx.run((tx) => tx.select().from(schema.stateRules).where(eq(schema.stateRules.tenantId, ctx.tenant.id)).orderBy(schema.stateRules.priority));
  const preview = await previewStateRules(tenant);
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild variant="outline">
            <Link href={`/t/${tenant}/settings`}>{t("back_to_settings")}</Link>
          </Button>
        }
      />
      <StateRulesEditor
        slug={tenant}
        statuses={[...ORDER_STATUSES]}
        rules={rules.map((r) => ({ id: r.id, name: r.name, priority: r.priority, resultStatus: r.resultStatus, isActive: r.isActive, conditions: r.conditions as Record<string, unknown> }))}
        preview={preview}
      />
    </>
  );
}
