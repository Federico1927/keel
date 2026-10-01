import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb, desc, eq, inArray, schema, sql } from "@keel/db";
import { Badge, Button, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { formatDateTime } from "@keel/core";
import { PAGE_SIZE } from "@keel/config";
import { requirePage } from "@/server/tenant";

export default async function AuditPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ page?: string; action?: string }> }) {
  const { tenant } = await params;
  const { page: pageRaw, action } = await searchParams;
  const ctx = await requirePage(tenant, "audit");
  const t = await getTranslations("audit");
  const page = Math.max(1, Number(pageRaw ?? 1) || 1);
  const where = action ? sql`${schema.auditLogs.tenantId} = ${ctx.tenant.id} and ${schema.auditLogs.action} like ${action + "%"}` : eq(schema.auditLogs.tenantId, ctx.tenant.id);
  const { rows, total } = await ctx.run(async (tx) => {
    const rows = await tx.select().from(schema.auditLogs).where(where).orderBy(desc(schema.auditLogs.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
    const counted = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(where);
    return { rows, total: counted[0]?.n ?? 0 };
  });
  const actorIds = [...new Set(rows.flatMap((r) => [r.actorUserId, r.impersonatedBy]).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
  const actorName = (id: string | null) => (id ? (actors.find((a) => a.id === id)?.name ?? actors.find((a) => a.id === id)?.email ?? id.slice(0, 8)) : null);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("when")}</TableHead>
                  <TableHead>{t("actor")}</TableHead>
                  <TableHead>{t("action")}</TableHead>
                  <TableHead>{t("entity")}</TableHead>
                  <TableHead>{t("changes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const diff = r.diff as Record<string, { from: unknown; to: unknown }>;
                  const keys = Object.keys(diff);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                      <TableCell>
                        <span className="text-sm">{actorName(r.actorUserId) ?? t("system")}</span>
                        {r.actorType !== "user" && <Badge variant="outline" className="ml-2">{t(`actor_types.${r.actorType}`)}</Badge>}
                        {r.impersonatedBy && <span className="block text-xs text-muted-foreground">{t("via", { name: actorName(r.impersonatedBy) ?? "" })}</span>}
                      </TableCell>
                      <TableCell><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.action}</code></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.entityType ? `${r.entityType} · ${r.entityId ?? ""}` : "—"}</TableCell>
                      <TableCell className="max-w-md text-xs">
                        {keys.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {keys.slice(0, 6).map((k) => (
                              <li key={k} className="truncate">
                                <span className="font-medium">{k}</span>: <span className="text-muted-foreground line-through">{String(diff[k]?.from ?? "∅")}</span> → {String(diff[k]?.to ?? "∅")}
                              </li>
                            ))}
                            {keys.length > 6 && <li className="text-muted-foreground">+{keys.length - 6}</li>}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>{t("pagination", { page, pages, total })}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={`?page=${page - 1}`}>‹</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={`?page=${page + 1}`}>›</Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
