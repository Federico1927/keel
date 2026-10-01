import { getTranslations } from "next-intl/server";
import { PageHeader } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { NewTenantForm } from "./form";

export default async function NewTenantPage() {
  await requireSuperAdmin();
  const t = await getTranslations("admin");
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("new_tenant.title")} description={t("new_tenant.description")} />
      <NewTenantForm />
    </>
  );
}
