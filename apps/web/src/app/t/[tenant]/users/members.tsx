"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { TENANT_ROLES, canManageRole, type TenantRole } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { changeMemberRole, inviteMember, resendInvitationAction, revokeInvitationAction, setMemberActive } from "@/server/actions/users";
import type { ActionResult } from "@/server/action-result";

interface Member { userId: string; name: string | null; email: string; role: TenantRole; isActive: boolean; lastLoginAt: string | null }

export function MembersTable({ slug, currentUserId, actorRole, locale, timezone, members }: { slug: string; currentUserId: string; actorRole: TenantRole; locale: string; timezone: string; members: Member[] }) {
  const t = useTranslations("users");
  const tr = useTranslations("roles");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const canManage = canManageRole(actorRole, "viewer");
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("member")}</TableHead>
              <TableHead>{t("role")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("last_login")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const editable = canManage && m.userId !== currentUserId && canManageRole(actorRole, m.role);
              return (
                <TableRow key={m.userId} className={m.isActive ? "" : "opacity-60"}>
                  <TableCell>
                    <p className="font-medium">{m.name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </TableCell>
                  <TableCell>
                    {editable ? (
                      <Select
                        size="sm"
                        aria-label={t("role")}
                        defaultValue={m.role}
                        disabled={pending}
                        className="w-40"
                        onChange={(e) => start(() => void changeMemberRole(slug, m.userId, e.target.value))}
                      >
                        {TENANT_ROLES.filter((r) => canManageRole(actorRole, r)).map((r) => (
                          <option key={r} value={r}>
                            {tr(r)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant="secondary">{tr(m.role)}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.isActive ? "success" : "muted"}>{m.isActive ? t("active") : t("inactive")}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDateTime(m.lastLoginAt, locale, timezone)}</TableCell>
                  <TableCell className="text-right">
                    {editable && (
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(() => void setMemberActive(slug, m.userId, !m.isActive))}>
                        {m.isActive ? t("deactivate") : t("reactivate")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {members.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  {tc("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function InviteForm({ slug, actorRole }: { slug: string; actorRole: TenantRole }) {
  const t = useTranslations("users");
  const tr = useTranslations("roles");
  const [state, action, pending] = useActionState(inviteMember.bind(null, slug), null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  if (!canManageRole(actorRole, "viewer")) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("invite_title")}</CardTitle>
        <CardDescription>{t("invite_description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={form} action={action} className="space-y-3" data-testid="invite-form">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t("email")}</Label>
            <Input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">{t("name_optional")}</Label>
            <Input id="invite-name" name="name" maxLength={120} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">{t("role")}</Label>
            <Select id="invite-role" name="role" defaultValue="operations">
              {TENANT_ROLES.filter((r) => canManageRole(actorRole, r)).map((r) => (
                <option key={r} value={r}>
                  {tr(r)}
                </option>
              ))}
            </Select>
          </div>
          {state && (
            <Alert variant={state.ok ? "info" : "destructive"}>
              <AlertDescription data-testid="invite-result">{state.ok ? t("invited") : <ErrorText error={state.error} />}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {t("invite")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ErrorText({ error }: { error: string }) {
  const t = useTranslations("users");
  const tc = useTranslations("common");
  return <>{t.has(`errors.${error}`) ? t(`errors.${error}`) : tc.has(`errors.${error}`) ? tc(`errors.${error}`) : tc("errors.unknown")}</>;
}

interface InvitationRow { id: string; email: string; name: string | null; role: TenantRole; state: "pending" | "expired" | "accepted" | "revoked"; expiresAt: string; lastSentAt: string; sendCount: number; invitedByName: string | null }

/** Pending, expired and recently revoked invitations, with resend and revoke for owners and admins. A list, not a table: readable on a phone. */
export function InvitationsList({ slug, actorRole, locale, timezone, invitations }: { slug: string; actorRole: TenantRole; locale: string; timezone: string; invitations: InvitationRow[] }) {
  const t = useTranslations("users");
  const tr = useTranslations("roles");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const variant = { pending: "info", expired: "warning", revoked: "muted", accepted: "success" } as const;
  return (
    <Card data-testid="invitations">
      <CardHeader>
        <CardTitle>{t("invitations_title")}</CardTitle>
        <CardDescription>{t("invitations_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result && !result.ok && (
          <Alert variant="destructive">
            <AlertDescription><ErrorText error={result.error} /></AlertDescription>
          </Alert>
        )}
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("invitations_empty")}</p>
        ) : (
          <ul className="divide-y">
            {invitations.map((i) => {
              const manageable = canManageRole(actorRole, i.role) && (i.state === "pending" || i.state === "expired");
              return (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3" data-testid="invitation-row">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.name ?? i.email}</p>
                    {i.name && <p className="truncate text-xs text-muted-foreground">{i.email}</p>}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="secondary">{tr(i.role)}</Badge>
                      <Badge variant={variant[i.state]}>{t(`invitation_states.${i.state}`)}</Badge>
                      <span>{i.state === "pending" ? t("invitation_expires", { date: formatDateTime(i.expiresAt, locale, timezone) }) : i.state === "expired" ? t("invitation_expired_on", { date: formatDateTime(i.expiresAt, locale, timezone) }) : null}</span>
                      {i.invitedByName && <span>· {t("invitation_by", { name: i.invitedByName })}</span>}
                    </p>
                  </div>
                  {manageable && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={pending} data-testid="invitation-resend" onClick={() => start(async () => setResult(await resendInvitationAction(slug, i.id)))}>
                        {t("invitation_resend")}
                      </Button>
                      {i.state === "pending" && (
                        <Button size="sm" variant="ghost" disabled={pending} data-testid="invitation-revoke" onClick={() => start(async () => setResult(await revokeInvitationAction(slug, i.id)))}>
                          {t("invitation_revoke")}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
