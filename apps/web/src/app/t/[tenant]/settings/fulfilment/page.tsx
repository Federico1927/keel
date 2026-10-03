import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@hullwise/config";
import { listStatusMappings, unmappedExternalStatuses } from "@hullwise/services";
import { Button, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { ClockForm, MappingEditor } from "./forms";

import { withIntl } from "@/i18n/intl-scope";
/** Settings → Fulfilment: the shipping clock (working days, threshold), the carrier email and the shipment status mappings. */
async function FulfilmentSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("settings_fulfilment");
  const { mappings, unmapped } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { mappings: await listStatusMappings(s), unmapped: await unmappedExternalStatuses(s) };
  });
  const canEdit = canDo(ctx.role, "manage_settings");
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2">
        <Link href={`/t/${tenant}/settings`}><ArrowLeft /> {t("back")}</Link>
      </Button>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        <ClockForm slug={tenant} canEdit={canEdit} timezone={ctx.tenant.timezone} values={{ lateToShipBusinessDays: ctx.settings.lateToShipBusinessDays, workdays: ctx.settings.workdays, carrierInstructionEmail: ctx.settings.carrierInstructionEmail }} />
        <MappingEditor slug={tenant} canEdit={canEdit} rows={mappings.map((m) => ({ id: m.id, source: m.source, externalStatus: m.externalStatus, canonicalStatus: m.canonicalStatus, isException: m.isException, isFinal: m.isFinal }))} unmapped={unmapped} />
      </div>
    </>
  );
}

export default withIntl(FulfilmentSettingsPage, "app/t/[tenant]/settings/fulfilment/page.tsx");
