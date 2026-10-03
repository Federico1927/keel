import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/server/admin";
import { ProfileView } from "@/components/profile/profile-view";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("profile"))("title") };
}

async function AdminProfilePage() {
  const { user } = await requireSuperAdmin();
  return <ProfileView user={user} tenant={null} locale={await getLocale()} />;
}

export default withIntl(AdminProfilePage, "app/admin/profile/page.tsx");
