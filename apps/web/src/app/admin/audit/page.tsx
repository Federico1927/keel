import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { and, asc, desc, eq, inArray, isNotNull, schema, sql, type SQL } from "@hullwise/db";
import { AUDIT_ACTOR_TYPES, auditFilterConditions, parseAuditFilters } from "@hullwise/services";
import { formatDateTime } from "@hullwise/core";
import { Badge, Button, Card, CardContent, Input, Label, PageHeader, Pagination, Select, DataList } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";

import { withIntl } from "@/i18n/intl-scope";
const PAGE_SIZE = 100;

async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const a = schema.auditLogs;
  const isUuid = (v?: string) => Boolean(v && /^[0-9a-f-]{36}$/i.test(v));
  const page = Math.max(1, Number(query.page) || 1);
  // actor (email), actor type, entity, record, action and dates: the same conditions as the owner's audit page (#32)
  const filters = parseAuditFilters(query);
  const conds: SQL[] = auditFilterConditions(filters);
  if (query.tenant === "platform") conds.push(sql`${a.tenantId} is null`);
  else if (isUuid(query.tenant)) conds.push(eq(a.tenantId, query.tenant!));
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [count], tenants, entityTypes] = await Promise.all([
    db.select({ log: a, tenantName: schema.tenants.name }).from(a).leftJoin(schema.tenants, eq(schema.tenants.id, a.tenantId)).where(where).orderBy(desc(a.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(a).where(where),
    db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name)),
    db.selectDistinct({ type: a.entityType }).from(a).where(isNotNull(a.entityType)).orderBy(asc(a.entityType)),
  ]);
  const actorIds = [...new Set(rows.flatMap((r) => [r.log.actorUserId, r.log.impersonatedBy]).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
  const who = (id: string | null) => (id ? (actors.find((x) => x.id === id)?.email ?? id.slice(0, 8)) : "system");
  const total = count?.n ?? 0;
  // every applied filter as a removable chip on phones
  const FILTER_KEYS = ["action", "tenant", "actor", "actor_type", "entity_type", "entity", "from", "to"] as const;
  const chips: AdminFilterChip[] = FILTER_KEYS.filter((k) => query[k]).map((k) => ({ key: k, label: k === "tenant" ? (query.tenant === "platform" ? t("audit.platform") : (tenants.find((x) => x.id === query.tenant)?.name ?? query.tenant!)) : query[k]!, href: queryHref("/admin/audit", query, { [k]: undefined, page: undefined }) }));
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("audit.title")} description={t("audit.description")} />
      <AdminFilters chips={chips}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-4" method="get" action="/admin/audit">
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
              {AUDIT_ACTOR_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-entity-type">{t("audit.entity")}</Label>
            <Select id="a-entity-type" name="entity_type" defaultValue={filters.entityType ?? ""}>
              <option value="">{t("filters.all")}</option>
              {entityTypes.map((x) => <option key={x.type} value={x.type!}>{x.type}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-record">{t("audit.record")}</Label>
            <Input id="a-record" name="entity" defaultValue={filters.entityId ?? ""} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-from">{t("audit.from")}</Label>
            <Input id="a-from" type="date" name="from" defaultValue={filters.from ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-to">{t("audit.to")}</Label>
            <Input id="a-to" type="date" name="to" defaultValue={filters.to ?? ""} />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {conds.length > 0 && <Button variant="outline" asChild><Link href="/admin/audit">{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <Card>
        <CardContent className="p-0">
          <DataList
            rows={rows}
            rowKey={({ log: x }) => x.id}
            rowProps={() => ({ "data-testid": "audit-row" })}
            columns={[
              { key: "when", header: t("audit.when"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: ({ log: x }) => formatDateTime(x.createdAt, locale, "UTC") },
              { key: "tenant", header: t("audit.tenant"), className: "text-xs", cell: ({ tenantName }) => tenantName ?? "—" },
              { key: "actor", header: t("audit.actor"), mobile: "subtitle", className: "break-all text-xs", cell: ({ log: x }) => <>{who(x.actorUserId)} <Badge variant={x.actorType === "impersonation" || x.actorType === "super_admin" ? "platform" : "outline"}>{x.actorType}</Badge>{x.impersonatedBy && <span className="text-muted-foreground"> ← {who(x.impersonatedBy)}</span>}</> },
              { key: "action", header: t("audit.action"), mobile: "title", className: "break-all font-mono text-xs", cell: ({ log: x }) => x.action },
              { key: "details", header: t("audit.details"), mobile: "subtitle", className: "truncate text-xs text-muted-foreground md:max-w-[24rem]", cell: ({ log: x }) => <span title={JSON.stringify({ ...(x.diff as object), ...(x.metadata as object) })}>{x.entityType ? <Link href={queryHref("/admin/audit", {}, { entity_type: x.entityType, entity: x.entityId ?? undefined })} className="hover:underline">{`${x.entityType}:${x.entityId ?? ""}`}</Link> : null} {JSON.stringify(x.diff)}</span> },
            ]}
          />
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={page} pageSize={PAGE_SIZE} total={total} hrefFor={(p) => queryHref("/admin/audit", query, { page: String(p) })} summary={t("audit.summary", { from: total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })} />
    </>
  );
}

export default withIntl(AdminAuditPage, "app/admin/audit/page.tsx");
