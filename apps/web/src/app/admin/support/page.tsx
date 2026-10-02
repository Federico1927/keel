import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { SUPPORT_STATUSES, adminListSupportTickets } from "@hullwise/services";
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { STATUS_VARIANT } from "@/app/t/[tenant]/support/status";

export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ status?: string; tenant?: string }> }) {
  const { db } = await requireSuperAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin");
  const ts = await getTranslations("support");
  const locale = await getLocale();
  const status = (SUPPORT_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const tenantId = sp.tenant && /^[0-9a-f-]{36}$/i.test(sp.tenant) ? sp.tenant : undefined;
  const { rows, counts } = await adminListSupportTickets(db, { status, tenantId });
  const chip = (href: string, active: boolean, label: React.ReactNode) => (
    <Link href={href} className={cn("rounded-full border px-3 py-1 text-xs", active ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>{label}</Link>
  );
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("support.title")} description={t("support.description")} />
      <div className="mb-4 flex flex-wrap gap-2">
        {chip("/admin/support", !status, t("support.all"))}
        {SUPPORT_STATUSES.map((s) => chip(`/admin/support?status=${s}`, status === s, <>{ts(`statuses.${s}`)} <span className="tabular opacity-70">{formatNumber(counts[s], locale)}</span></>))}
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ts("columns.ticket")}</TableHead>
                <TableHead>{t("support.tenant")}</TableHead>
                <TableHead>{ts("columns.status")}</TableHead>
                <TableHead className="hidden md:table-cell">{ts("columns.updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.t.id} data-testid="admin-ticket-row">
                  <TableCell>
                    <Link href={`/admin/support/${r.t.id}`} className="font-medium hover:underline">#{r.t.number} · {r.t.subject}</Link>
                    <p className="text-xs text-muted-foreground">{ts(`categories.${r.t.category}`)} · {r.authorEmail ?? "—"} · {ts("messages_n", { n: formatNumber(r.messages, locale) })}</p>
                  </TableCell>
                  <TableCell className="text-sm"><Link href={`/admin/support?tenant=${r.t.tenantId}`} className="hover:underline">{r.tenantName}</Link></TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[r.t.status] ?? "muted"}>{ts(`statuses.${r.t.status}`)}</Badge></TableCell>
                  <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">{formatDateTime(r.t.lastMessageAt, locale, "UTC")}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">{t("support.empty")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
