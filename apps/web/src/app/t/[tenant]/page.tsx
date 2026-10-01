import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireUser, getMemberships } from "@/server/session";

export default async function TenantHome({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const user = await requireUser();
  const memberships = await getMemberships(user.id);
  const m = memberships.find((x) => x.slug === tenant);
  if (!m) notFound();
  const t = await getTranslations("common");
  return (
    <main className="p-8">
      <h1 className="text-2xl">{m.name}</h1>
      <p className="text-muted-foreground">
        {t("signed_in_as", { name: user.name ?? user.email, role: m.role })}
      </p>
    </main>
  );
}
