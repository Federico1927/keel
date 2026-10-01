import { getTranslations } from "next-intl/server";
import { EmptyState } from "@keel/ui";

export default async function TenantNotFound() {
  const t = await getTranslations("shell");
  return <EmptyState title={t("not_found_title")} description={t("not_found_description")} />;
}
