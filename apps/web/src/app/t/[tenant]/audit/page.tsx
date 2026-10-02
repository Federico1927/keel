import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb, and, asc, desc, eq, inArray, isNotNull, schema, sql } from "@hullwise/db";
import { Badge, Button, Card, CardContent, DataList, EmptyState, Input, Label, PageHeader, Pagination, Select } from "@hullwise/ui";
import { formatDateTime, displayName } from "@hullwise/core";
import { PAGE_SIZE } from "@hullwise/config";
import { AUDIT_ACTOR_TYPES, auditFilterConditions, parseAuditFilters } from "@hullwise/services";
import { requirePage } from "@/server/tenant";

type Search = Record<string, string | string[] | undefined>;

export default async function AuditPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Search> }) {
  const { tenant } = await params;
  const query = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
  const ctx = await requirePage(tenant, "audit");
  const t = await getTranslations("audit");
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  // filters by actor, entity, record and date (#32); the console's audit page shares the same conditions
  const filters = parseAuditFilters({ ...query, actor: undefined });
  const a = schema.auditLogs;
  const where = and(eq(a.tenantId, ctx.tenant.id), ...auditFilterConditions(filters, { timezone: ctx.tenant.timezone }));
  const { rows, total, entityTypes } = await ctx.run(async (tx) => {
    const rows = await tx.select().from(a).where(where).orderBy(desc(a.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
    const counted = await tx.select({ n: sql<number>`count(*)::int` }).from(a).where(where);
    const entityTypes = await tx.selectDistinct({ type: a.entityType }).from(a).where(and(eq(a.tenantId, ctx.tenant.id), isNotNull(a.entityType))).orderBy(asc(a.entityType));
    return { rows, total: counted[0]?.n ?? 0, entityTypes: entityTypes.map((e) => e.type!) };
  });
  // people are platform rows: names of the members and of the actors on this page
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, preferredName: schema.users.preferredName, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id)).orderBy(asc(schema.users.email));
  const actorIds = [...new Set(rows.flatMap((r) => [r.actorUserId, r.impersonatedBy]).filter((x): x is string => Boolean(x) && !members.some((m) => m.id === x)))];
  const others = actorIds.length ? await adminDb().select({ id: schema.users.id, name: schema.users.name, preferredName: schema.users.preferredName, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
  const people = [...members, ...others];
  const actorName = (id: string | null) => (id ? (people.some((p) => p.id === id) ? displayName(people.find((p) => p.id === id)) : id.slice(0, 8)) : null);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base = `/t/${tenant}/audit`;
  const hrefFor = (p: number) => {
    const q = new URLSearchParams(Object.entries({ ...query, page: String(p) }).filter((e): e is [string, string] => Boolean(e[1])));
    return `${base}?${q}`;
  };
  const filtered = Object.keys(filters).length > 0;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4" method="get" action={base} data-testid="audit-filters">
        <div className="space-y-1.5">
          <Label htmlFor="af-actor">{t("filters.actor")}</Label>
          <Select id="af-actor" name="actor_id" defaultValue={filters.actorUserId ?? ""}>
            <option value="">{t("filters.all")}</option>
            {members.map((m) => <option key={m.id} value={m.id}>{displayName(m)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-type">{t("filters.actor_type")}</Label>
          <Select id="af-type" name="actor_type" defaultValue={filters.actorType ?? ""}>
            <option value="">{t("filters.all")}</option>
            {AUDIT_ACTOR_TYPES.map((x) => <option key={x} value={x}>{t(`actor_types.${x}`)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-entity">{t("filters.entity")}</Label>
          <Select id="af-entity" name="entity_type" defaultValue={filters.entityType ?? ""}>
            <option value="">{t("filters.all")}</option>
            {entityTypes.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-record">{t("filters.record")}</Label>
          <Input id="af-record" name="entity" defaultValue={filters.entityId ?? ""} placeholder={t("filters.record_placeholder")} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-action">{t("filters.action")}</Label>
          <Input id="af-action" name="action" defaultValue={filters.action ?? ""} placeholder="order." autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-from">{t("filters.from")}</Label>
          <Input id="af-from" type="date" name="from" defaultValue={filters.from ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-to">{t("filters.to")}</Label>
          <Input id="af-to" type="date" name="to" defaultValue={filters.to ?? ""} />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {filtered && <Button variant="outline" asChild><Link href={base}>{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={filtered ? t("filters.empty_title") : t("empty_title")} description={filtered ? t("filters.empty_description") : t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "audit-row" })}
              columns={[
                { key: "when", header: t("when"), mobile: "subtitle", className: "whitespace-nowrap text-sm text-muted-foreground", cell: (r) => formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone) },
                { key: "actor", header: t("actor"), mobile: "title", cell: (r) => <><span className="text-sm">{actorName(r.actorUserId) ?? t("system")}</span>{r.actorType !== "user" && <Badge variant="outline" className="ml-2 font-normal">{t(`actor_types.${r.actorType}`)}</Badge>}{r.impersonatedBy && <span className="block text-xs font-normal text-muted-foreground">{t("via", { name: actorName(r.impersonatedBy) ?? "" })}</span>}</> },
                { key: "action", header: t("action"), mobile: "badge", cell: (r) => <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{r.action}</code> },
                { key: "entity", header: t("entity"), className: "text-sm text-muted-foreground max-md:break-all", cell: (r) => (r.entityType ? <Link href={`${base}?entity_type=${encodeURIComponent(r.entityType)}${r.entityId ? `&entity=${encodeURIComponent(r.entityId)}` : ""}`} className="hover:underline" title={t("filters.record_history")}>{r.entityType} · {r.entityId ?? ""}</Link> : "—") },
                {
                  key: "changes",
                  header: t("changes"),
                  label: "",
                  className: "text-xs max-md:basis-full max-md:min-w-0 md:max-w-md",
                  cell: (r) => {
                    const diff = r.diff as Record<string, { from: unknown; to: unknown }>;
                    const keys = Object.keys(diff);
                    return keys.length === 0 ? <span className="text-muted-foreground">—</span> : (
                      <ul className="space-y-0.5">
                        {keys.slice(0, 6).map((k) => (
                          <li key={k} className="truncate">
                            <span className="font-medium">{k}</span>: <span className="text-muted-foreground line-through">{String(diff[k]?.from ?? "∅")}</span> → {String(diff[k]?.to ?? "∅")}
                          </li>
                        ))}
                        {keys.length > 6 && <li className="text-muted-foreground">+{keys.length - 6}</li>}
                      </ul>
                    );
                  },
                },
              ]}
            />
          </CardContent>
        </Card>
      )}
      {total > 0 && <Pagination className="mt-4" page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} summary={t("pagination", { page, pages, total })} />}
    </>
  );
}
