import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { and, asc, desc, eq, inArray, or, schema, sql, type SQL } from "@keel/db";
import { formatDateTime } from "@keel/core";
import { Badge, Button, Card, CardContent, Input, Label, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";

const PAGE_SIZE = 100;
const ACTOR_TYPES = ["super_admin", "impersonation", "user", "system"] as const;

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const a = schema.auditLogs;
  const isUuid = (v?: string) => Boolean(v && /^[0-9a-f-]{36}$/i.test(v));
  const page = Math.max(1, Number(query.page) || 1);
  const conds: SQL[] = [];
  if (query.action) conds.push(sql`${a.action} like ${query.action.replace(/[\\%_]/g, (m) => `\\${m}`) + "%"}`);
  if (query.tenant === "platform") conds.push(sql`${a.tenantId} is null`);
  else if (isUuid(query.tenant)) conds.push(eq(a.tenantId, query.tenant!));
  if ((ACTOR_TYPES as readonly string[]).includes(query.actor_type ?? "")) conds.push(eq(a.actorType, query.actor_type!));
  if (isUuid(query.entity)) conds.push(eq(a.entityId, query.entity!));
  if (query.actor?.trim()) {
    const like = `%${query.actor.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(sql`${a.actorUserId} in (select id from users where email ilike ${like})`, sql`${a.impersonatedBy} in (select id from users where email ilike ${like})`)!);
  }
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [count], tenants] = await Promise.all([
    db.select({ log: a, tenantName: schema.tenants.name }).from(a).leftJoin(schema.tenants, eq(schema.tenants.id, a.tenantId)).where(where).orderBy(desc(a.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(a).where(where),
    db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name)),
  ]);
  const actorIds = [...new Set(rows.flatMap((r) => [r.log.actorUserId, r.log.impersonatedBy]).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
  const who = (id: string | null) => (id ? (actors.find((x) => x.id === id)?.email ?? id.slice(0, 8)) : "system");
  const total = count?.n ?? 0;
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("audit.title")} description={t("audit.description")} />
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]" method="get" action="/admin/audit">
        {query.entity && <input type="hidden" name="entity" value={query.entity} />}
        <div className="space-y-1.5">
          <Label htmlFor="a-action">{t("audit.action")}</Label>
          <Input id="a-action" name="action" defaultValue={query.action ?? ""} placeholder="tenant." autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-tenant">{t("audit.tenant")}</Label>
          <Select id="a-tenant" name="tenant" defaultValue={query.tenant ?? ""}>
            <option value="">{t("filters.all")}</option>
            <option value="platform">{t("audit.platform")}</option>
            {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-actor">{t("audit.actor")}</Label>
          <Input id="a-actor" name="actor" defaultValue={query.actor ?? ""} placeholder="email" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-type">{t("audit.actor_type")}</Label>
          <Select id="a-type" name="actor_type" defaultValue={query.actor_type ?? ""}>
            <option value="">{t("filters.all")}</option>
            {ACTOR_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {conds.length > 0 && <Button variant="outline" asChild><Link href="/admin/audit">{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("audit.when")}</TableHead>
                <TableHead>{t("audit.tenant")}</TableHead>
                <TableHead>{t("audit.actor")}</TableHead>
                <TableHead>{t("audit.action")}</TableHead>
                <TableHead>{t("audit.details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ log: x, tenantName }) => (
                <TableRow key={x.id} data-testid="audit-row">
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(x.createdAt, locale, "UTC")}</TableCell>
                  <TableCell className="text-xs">{tenantName ?? "—"}</TableCell>
                  <TableCell className="text-xs">{who(x.actorUserId)} <Badge variant={x.actorType === "impersonation" || x.actorType === "super_admin" ? "platform" : "outline"}>{x.actorType}</Badge>{x.impersonatedBy && <span className="text-muted-foreground"> ← {who(x.impersonatedBy)}</span>}</TableCell>
                  <TableCell className="font-mono text-xs">{x.action}</TableCell>
                  <TableCell className="max-w-[24rem] truncate text-xs text-muted-foreground" title={JSON.stringify({ ...(x.diff as object), ...(x.metadata as object) })}>{x.entityType ? `${x.entityType}:${x.entityId ?? ""} ` : ""}{JSON.stringify(x.diff)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={page} pageSize={PAGE_SIZE} total={total} hrefFor={(p) => queryHref("/admin/audit", query, { page: String(p) })} summary={t("audit.summary", { from: total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })} />
    </>
  );
}
