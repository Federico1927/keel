import { redirect } from "next/navigation";
import { getCurrentUser, getMemberships } from "@/server/session";

import { withIntl } from "@/i18n/intl-scope";
async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const memberships = await getMemberships(user.id);
  if (memberships.length === 0) {
    if (user.isSuperAdmin) redirect("/admin");
    redirect("/login?error=no_tenant");
  }
  redirect(`/t/${memberships[0]!.slug}`);
}

export default withIntl(Home, "app/page.tsx");
