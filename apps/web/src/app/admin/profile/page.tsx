import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/server/admin";
import { ProfileView } from "@/components/profile/profile-view";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("profile"))("title") };
}

export default async function AdminProfilePage() {
  const { user } = await requireSuperAdmin();
  return <ProfileView user={user} tenant={null} locale={await getLocale()} />;
}
