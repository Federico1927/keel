import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb } from "@hullwise/db";
import { describeUserAgent, displayName, formatDateTime, initials, isTimeZone } from "@hullwise/core";
import { getAccountProfile, listRecentSignIns, pendingEmailChange } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import type { CurrentUser } from "@/server/session";
import { getMemberships } from "@/server/session";
import { avatarUrl } from "@/server/avatar";
import { AvatarField, EmailForm, IdentityForm, PasswordForm, PreferencesForm, SignInAlertsToggle, SignOutOthersButton } from "./forms";
import { McpConnectionsSection } from "@/components/mcp/connections";

/**
 * The signed-in person's profile (#45), shared by /t/<tenant>/profile and /admin/profile: identity,
 * preferences, security and the workspaces they belong to. Each user only ever sees their own.
 */
export async function ProfileView({ user, tenant, locale }: { user: CurrentUser; tenant: { slug: string; timezone: string; defaultLocale: string } | null; locale: string }) {
  const t = await getTranslations("profile");
  const tc = await getTranslations("common");
  const tr = await getTranslations("roles");
  const db = adminDb();
  const [memberships, signIns, pending, account] = await Promise.all([getMemberships(user.id), listRecentSignIns({ db, userId: user.id }, 8), pendingEmailChange(db, user.id), getAccountProfile(db, user.id)]);
  const zone = user.timeZone && isTimeZone(user.timeZone) ? user.timeZone : (tenant?.timezone ?? "UTC");
  const timeZones = Intl.supportedValuesOf("timeZone");
  const tenantLocaleLabel = tenant && ["en", "it", "es"].includes(tenant.defaultLocale) ? tc(`locales.${tenant.defaultLocale as "en"}`) : null;
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("identity")}</CardTitle>
            <CardDescription>{t("identity_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <AvatarField name={displayName(user)} initials={initials(user)} avatarUrl={avatarUrl(user)} />
            <IdentityForm values={{ name: user.name ?? "", preferredName: user.preferredName ?? "", jobTitle: user.jobTitle ?? "" }} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("preferences")}</CardTitle>
            <CardDescription>{t("preferences_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <PreferencesForm tenantSlug={tenant?.slug ?? null} values={{ locale: user.locale ?? "", theme: user.theme, density: user.density, timeZone: user.timeZone ?? "" }} timeZones={timeZones} tenantTimeZone={tenant?.timezone ?? null} tenantLocaleLabel={tenantLocaleLabel} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("security")}</CardTitle>
            <CardDescription>{t("security_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-8">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t("email")}</h3>
              <EmailForm email={user.email} pending={pending?.email ?? null} />
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t("password")}</h3>
              <PasswordForm />
            </section>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("sessions")}</CardTitle>
              <CardDescription>{t("sessions_description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table data-testid="sign-ins">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("sign_in_when")}</TableHead>
                    <TableHead>{t("sign_in_method")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("sign_in_device")}</TableHead>
                    <TableHead className="hidden sm:table-cell">IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signIns.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(s.createdAt, locale, zone)}</TableCell>
                      <TableCell>{t(`sign_in_methods.${s.method === "email" ? "email" : s.method === "credentials" ? "credentials" : s.method === "one-time" ? "one_time" : "other"}`)}</TableCell>
                      <TableCell className="hidden sm:table-cell">{describeUserAgent(s.userAgent)?.label ?? "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">{s.ip ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                  {signIns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">{tc("empty")}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <SignOutOthersButton />
              <SignInAlertsToggle enabled={account?.notifyNewSignIn ?? true} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("workspaces")}</CardTitle>
              <CardDescription>{t("workspaces_description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y" data-testid="profile-workspaces">
                {memberships.map((m) => (
                  <li key={m.tenantId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={`/t/${m.slug}`} className="font-medium hover:underline">{m.name}</Link>
                    <Badge variant="secondary">{tr(m.role)}</Badge>
                  </li>
                ))}
                {memberships.length === 0 && <li className="py-2 text-sm text-muted-foreground">{user.isSuperAdmin ? t("workspaces_super_admin") : tc("empty")}</li>}
              </ul>
            </CardContent>
          </Card>
        </div>
        {tenant && (
          <Card className="xl:col-span-2" id="connections">
            <CardHeader>
              <CardTitle>{t("connections")}</CardTitle>
              <CardDescription>{t("connections_description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <McpConnectionsSection slug={tenant.slug} locale={locale} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
