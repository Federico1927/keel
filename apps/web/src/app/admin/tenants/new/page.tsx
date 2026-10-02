import { getTranslations } from "next-intl/server";
import { PageHeader } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { NewTenantForm } from "./form";

import { withIntl } from "@/i18n/intl-scope";
async function NewTenantPage() {
  await requireSuperAdmin();
  const t = await getTranslations("admin");
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("new_tenant.title")} description={t("new_tenant.description")} />
      <NewTenantForm />
    </>
  );
}

export default withIntl(NewTenantPage, "app/admin/tenants/new/page.tsx");
