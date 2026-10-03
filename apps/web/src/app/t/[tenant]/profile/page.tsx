import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getTenantContext } from "@/server/tenant";
import { ProfileView } from "@/components/profile/profile-view";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("profile"))("title") };
}

/** Every member's own profile: no page permission beyond membership. */
async function TenantProfilePage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await getTenantContext(tenant);
  return <ProfileView user={ctx.user} tenant={{ slug: ctx.tenant.slug, timezone: ctx.tenant.timezone, defaultLocale: ctx.tenant.defaultLocale }} locale={ctx.locale} />;
}

export default withIntl(TenantProfilePage, "app/t/[tenant]/profile/page.tsx");
