import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { describeUserAgent, formatDateTime } from "@keel/core";
import { adminUserDetail } from "@keel/services";
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DetailShell, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { SendPasswordResetButton } from "../../tenants/[id]/controls";
import { LifecycleBadge } from "../../_components/badges";
import { DisableUserButton, RevokeSessionsButton } from "./controls";

/** One person across tenants (#48): memberships, sign-ins, audited actions. Never a password. */
export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, user: me } = await requireSuperAdmin();
  const d = await adminUserDetail(db, id);
  if (!d) notFound();
  const t = await getTranslations("admin");
  const tr = await getTranslations("roles");
  const locale = await getLocale();
  const u = d.user;
  const when = (x: Date | null) => (x ? formatDateTime(x, locale, "UTC") : "—");
  return (
    <DetailShell
      back={<Link href="/admin/users" className="hover:underline">← {t("users.title")}</Link>}
      eyebrow={u.email}
      title={u.name ?? u.email}
      chips={<>{u.isSuperAdmin && <Badge variant="platform">{t("users.super_admin")}</Badge>}{u.disabledAt ? <Badge variant="destructive" data-testid="user-status">{t("users.disabled")}</Badge> : <Badge variant="success" data-testid="user-status">{t("users.active")}</Badge>}</>}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {!u.disabledAt && <SendPasswordResetButton userId={u.id} />}
          <RevokeSessionsButton userId={u.id} />
          <DisableUserButton userId={u.id} disabled={Boolean(u.disabledAt)} self={u.id === me.id} />
        </div>
      }
      aside={
        <Card>
          <CardHeader><CardTitle className="text-base">{t("user.account")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("users.columns.last_login")}</dt><dd>{u.lastLoginAt ? when(u.lastLoginAt) : t("users.never")}</dd>
              <dt className="text-muted-foreground">{t("user.created")}</dt><dd>{when(u.createdAt)}</dd>
              <dt className="text-muted-foreground">{t("user.email_verified")}</dt><dd>{when(u.emailVerified)}</dd>
              <dt className="text-muted-foreground">{t("user.password_changed")}</dt><dd>{when(u.passwordChangedAt)}</dd>
              <dt className="text-muted-foreground">{t("user.language")}</dt><dd>{u.locale ?? "—"}</dd>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{t("user.no_passwords")}</p>
          </CardContent>
        </Card>
      }
    >
      {u.disabledAt && (
        <Alert variant="destructive" data-testid="user-disabled-alert">
          <AlertTitle>{t("user.disabled_since", { date: when(u.disabledAt) })}</AlertTitle>
          <AlertDescription>{u.disabledReason ?? t("user.no_reason")}{d.disabledByEmail ? ` · ${t("user.disabled_by", { email: d.disabledByEmail })}` : ""}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader><CardTitle className="text-base">{t("users.columns.tenants")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {d.memberships.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t("user.no_tenants")}</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>{t("tenants.columns.tenant")}</TableHead><TableHead>{t("user.role")}</TableHead><TableHead className="hidden sm:table-cell">{t("user.since")}</TableHead></TableRow></TableHeader>
              <TableBody>
                {d.memberships.map((m) => (
                  <TableRow key={m.tenantId} data-testid="user-membership">
                    <TableCell><Link href={`/admin/tenants/${m.tenantId}`} className="font-medium hover:underline">{m.tenantName}</Link> <LifecycleBadge status={m.tenantStatus} label={t(`tenants.status.${m.tenantStatus}`)} /></TableCell>
                    <TableCell>{tr(m.role)}{!m.isActive && <Badge variant="muted" className="ml-2">{t("user.membership_inactive")}</Badge>}</TableCell>
                    <TableCell className="hidden text-xs sm:table-cell">{when(m.since)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t("user.sign_ins")}</CardTitle><CardDescription>{t("user.sign_ins_hint")}</CardDescription></CardHeader>
        <CardContent>
          {d.signIns.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
            <ul className="space-y-1 text-sm">{d.signIns.map((s) => <li key={s.id} className="flex flex-wrap gap-2"><span className="text-xs text-muted-foreground tabular">{when(s.createdAt)}</span><Badge variant="outline">{s.method}</Badge><span className="text-xs">{describeUserAgent(s.userAgent)?.label ?? "—"}</span></li>)}</ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t("user.activity")}</CardTitle></CardHeader>
        <CardContent>
          {d.audit.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
            <ul className="space-y-1 text-sm">{d.audit.map((a) => <li key={a.id} className="flex flex-wrap gap-2" data-testid="user-audit-row"><span className="text-xs text-muted-foreground tabular">{when(a.createdAt)}</span><span className="font-mono text-xs">{a.action}</span><Badge variant={a.actorType === "super_admin" ? "platform" : "outline"}>{a.actorType}</Badge></li>)}</ul>
          )}
        </CardContent>
      </Card>
    </DetailShell>
  );
}
