import { getTranslations } from "next-intl/server";
import { adminDb, eq, schema } from "@hullwise/db";
import { Button, PageHeader } from "@hullwise/ui";
import { canManageRole } from "@hullwise/config";
import { listInvitations } from "@hullwise/services";
import { requirePage } from "@/server/tenant";
import { InviteForm, InvitationsList, MembersTable } from "./members";

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
  const invitations = await ctx.run((tx) => listInvitations({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canManageRole(ctx.role, "viewer") ? <Button asChild className="lg:hidden"><a href="#invite" data-testid="invite-jump">{t("invite")}</a></Button> : undefined} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
        <MembersTable
          slug={ctx.tenant.slug}
          currentUserId={ctx.user.id}
          actorRole={ctx.role}
          locale={ctx.locale}
          timezone={ctx.tenant.timezone}
          members={members.map((m) => ({ ...m, lastLoginAt: m.lastLoginAt?.toISOString() ?? null }))}
        />
        <InvitationsList slug={ctx.tenant.slug} actorRole={ctx.role} locale={ctx.locale} timezone={ctx.tenant.timezone} invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), lastSentAt: i.lastSentAt.toISOString() }))} />
        </div>
        <InviteForm slug={ctx.tenant.slug} actorRole={ctx.role} />
      </div>
    </>
  );
}
