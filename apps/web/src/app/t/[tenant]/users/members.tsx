"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { TENANT_ROLES, canManageRole, type TenantRole } from "@keel/config";
import { formatDateTime } from "@keel/core";
import { changeMemberRole, inviteMember, setMemberActive } from "@/server/actions/users";

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
                        aria-label={t("role")}
                        defaultValue={m.role}
                        disabled={pending}
                        className="h-8 w-40"
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
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(inviteMember.bind(null, slug), null);
  if (!canManageRole(actorRole, "viewer")) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("invite_title")}</CardTitle>
        <CardDescription>{t("invite_description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">{t("name")}</Label>
            <Input id="invite-name" name="name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t("email")}</Label>
            <Input id="invite-email" name="email" type="email" required />
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
              <AlertDescription>{state.ok ? t("invited") : tc(`errors.${state.error}`)}</AlertDescription>
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
