import { getLocale, getTranslations } from "next-intl/server";
import { desc, eq, inArray, schema, sql } from "@keel/db";
import { formatDateTime } from "@keel/core";
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ action?: string; tenant?: string }> }) {
  const { db } = await requireSuperAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const where = sp.action ? sql`${schema.auditLogs.action} like ${sp.action + "%"}` : sp.tenant ? eq(schema.auditLogs.tenantId, sp.tenant) : undefined;
  const rows = await db.select({ log: schema.auditLogs, tenantName: schema.tenants.name }).from(schema.auditLogs).leftJoin(schema.tenants, eq(schema.tenants.id, schema.auditLogs.tenantId)).where(where).orderBy(desc(schema.auditLogs.createdAt)).limit(200);
  const actorIds = [...new Set(rows.flatMap((r) => [r.log.actorUserId, r.log.impersonatedBy]).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
  const who = (id: string | null) => (id ? (actors.find((a) => a.id === id)?.email ?? id.slice(0, 8)) : "system");
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("audit.title")} description={t("audit.description")} />
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
              {rows.map(({ log: a, tenantName }) => (
                <TableRow key={a.id} data-testid="audit-row">
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(a.createdAt, locale, "UTC")}</TableCell>
                  <TableCell className="text-xs">{tenantName ?? "—"}</TableCell>
                  <TableCell className="text-xs">{who(a.actorUserId)} <Badge variant={a.actorType === "impersonation" || a.actorType === "super_admin" ? "warning" : "outline"}>{a.actorType}</Badge>{a.impersonatedBy && <span className="text-muted-foreground"> ← {who(a.impersonatedBy)}</span>}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="max-w-[24rem] truncate text-xs text-muted-foreground" title={JSON.stringify({ ...(a.diff as object), ...(a.metadata as object) })}>{a.entityType ? `${a.entityType}:${a.entityId ?? ""} ` : ""}{JSON.stringify(a.diff)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
