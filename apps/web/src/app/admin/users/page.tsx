import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime } from "@keel/core";
import { USER_SORTS, userDirectory, type UserSort } from "@keel/services";
import { asc, schema } from "@keel/db";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { SortHead, flatParams, queryHref } from "../_components/table-query";

const KINDS = ["active", "disabled", "super_admin", "no_tenant"] as const;

/** Users directory (#48): anyone across tenants by name or email, with tenants, roles, last sign-in and the super-admin flag. */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const tr = await getTranslations("roles");
  const locale = await getLocale();
  const sort = (USER_SORTS as readonly string[]).includes(query.sort ?? "") ? (query.sort as UserSort) : "email";
  const dir = query.dir === "desc" ? "desc" : query.dir === "asc" ? "asc" : sort === "last_login" || sort === "created" ? "desc" : "asc";
  const kind = (KINDS as readonly string[]).includes(query.kind ?? "") ? query.kind : undefined;
  const [list, tenants] = await Promise.all([
    userDirectory(db, { q: query.q, kind, tenantId: query.tenant, sort, dir, page: Number(query.page) || 1 }),
    db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name)),
  ]);
  const base = "/admin/users";
  const sortProps = { sort, dir, base, query } as const;
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("users.title")} description={t("users.description")} />
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))_auto]" method="get" action={base} role="search">
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <div className="space-y-1.5">
          <Label htmlFor="u-q">{t("users.search")}</Label>
          <Input id="u-q" name="q" type="search" defaultValue={query.q ?? ""} placeholder={t("users.search_placeholder")} autoComplete="off" autoFocus data-testid="user-search" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="u-kind">{t("users.kind")}</Label>
          <Select id="u-kind" name="kind" defaultValue={kind ?? ""}>
            <option value="">{t("filters.all")}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`users.kinds.${k}`)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="u-tenant">{t("tenants.columns.tenant")}</Label>
          <Select id="u-tenant" name="tenant" defaultValue={query.tenant ?? ""}>
            <option value="">{t("filters.all")}</option>
            {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {(query.q || kind || query.tenant) && <Button variant="outline" asChild><Link href={base}>{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <Card>
        <CardContent className="p-0">
          {list.rows.length === 0 ? (
            <EmptyState title={t("users.empty")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label={t("users.columns.user")} column="email" {...sortProps} />
                  <TableHead>{t("users.columns.tenants")}</TableHead>
                  <SortHead label={t("users.columns.last_login")} column="last_login" {...sortProps} defaultDir="desc" className="hidden md:table-cell" />
                  <TableHead>{t("users.columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((u) => (
                  <TableRow key={u.id} data-testid="user-row" data-email={u.email}>
                    <TableCell>
                      <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">{u.name ?? u.email}</Link>
                      <div className="break-all text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      {u.memberships.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
                        <ul className="space-y-0.5 text-xs">
                          {u.memberships.map((m) => <li key={m.tenantId} className={m.isActive ? "" : "text-muted-foreground line-through"}>{m.tenantName} · {tr(m.role)}</li>)}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{u.lastLoginAt ? formatDateTime(u.lastLoginAt, locale, "UTC") : t("users.never")}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {u.isSuperAdmin && <Badge variant="platform">{t("users.super_admin")}</Badge>}
                        {u.disabledAt ? <Badge variant="destructive">{t("users.disabled")}</Badge> : <Badge variant="success">{t("users.active")}</Badge>}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => queryHref(base, query, { page: String(p) })} summary={t("users.summary", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total })} />
    </>
  );
}
