import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { DEFAULT_MOBILE_NAV, MOBILE_NAV_KEYS, TENANT_ROLES, canDo } from "@hullwise/config";
import { Button, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { MOBILE_NAV_ITEMS } from "@/components/app-shell/nav";
import { MobileNavForm } from "./form";

import { withIntl } from "@/i18n/intl-scope";
/** Settings → Mobile navigation (#49): the bottom-bar destinations of each role. */
async function MobileNavSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("mobile.settings");
  const tAll = await getTranslations();
  const tr = await getTranslations("roles");
  const label = (k: string) => tAll(MOBILE_NAV_ITEMS[k as keyof typeof MOBILE_NAV_ITEMS].labelKey);
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2">
        <Link href={`/t/${tenant}/settings`}><ArrowLeft /> {t("back")}</Link>
      </Button>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <MobileNavForm
        slug={tenant}
        canEdit={canDo(ctx.role, "manage_settings")}
        destinations={MOBILE_NAV_KEYS.map((k) => ({ key: k, label: label(k) }))}
        roles={TENANT_ROLES.map((r) => ({ role: r, label: tr(r), defaults: DEFAULT_MOBILE_NAV[r].map(label).join(", "), value: ctx.settings.mobileNav[r] ?? [] }))}
      />
    </>
  );
}

export default withIntl(MobileNavSettingsPage, "app/t/[tenant]/settings/mobile/page.tsx");
