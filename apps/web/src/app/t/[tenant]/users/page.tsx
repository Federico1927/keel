import { getTranslations } from "next-intl/server";
import { adminDb, eq, schema } from "@keel/db";
import { PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { InviteForm, MembersTable } from "./members";

export default async function UsersPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "users");
  const t = await getTranslations("users");
  const members = await adminDb()
    .select({
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.tenantMemberships.role,
      isActive: schema.tenantMemberships.isActive,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.tenantMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId))
    .where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id))
    .orderBy(schema.users.name);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <MembersTable
          slug={ctx.tenant.slug}
          currentUserId={ctx.user.id}
          actorRole={ctx.role}
          locale={ctx.locale}
          timezone={ctx.tenant.timezone}
          members={members.map((m) => ({ ...m, lastLoginAt: m.lastLoginAt?.toISOString() ?? null }))}
        />
        <InviteForm slug={ctx.tenant.slug} actorRole={ctx.role} />
      </div>
    </>
  );
}
