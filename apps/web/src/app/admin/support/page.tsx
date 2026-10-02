import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { SUPPORT_STATUSES, adminListSupportTickets } from "@hullwise/services";
import { Badge, Card, CardContent, PageHeader, DataList, cn } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { STATUS_VARIANT } from "@/app/t/[tenant]/support/status";

import { withIntl } from "@/i18n/intl-scope";
async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ status?: string; tenant?: string }> }) {
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
        {SUPPORT_STATUSES.map((s) => chip(`/admin/support?status=${s}`, status === s, <>{ts(`statuses.${s}`)} <span className="tabular font-normal">{formatNumber(counts[s], locale)}</span></>))}
      </div>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("support.empty")}</p> : (
            <DataList
              rows={rows}
              rowKey={(r) => r.t.id}
              rowProps={() => ({ "data-testid": "admin-ticket-row" })}
              columns={[
                { key: "ticket", header: ts("columns.ticket"), mobile: "title", cell: (r) => <>
                  <Link href={`/admin/support/${r.t.id}`} className="font-medium hover:underline">#{r.t.number} · {r.t.subject}</Link>
                  <p className="text-xs font-normal text-muted-foreground">{ts(`categories.${r.t.category}`)} · <span className="break-all">{r.authorEmail ?? "—"}</span> · {ts("messages_n", { n: formatNumber(r.messages, locale) })}</p>
                </> },
                { key: "tenant", header: t("support.tenant"), className: "text-sm", cell: (r) => <Link href={`/admin/support?tenant=${r.t.tenantId}`} className="hover:underline">{r.tenantName}</Link> },
                { key: "status", header: ts("columns.status"), mobile: "badge", cell: (r) => <Badge variant={STATUS_VARIANT[r.t.status] ?? "muted"}>{ts(`statuses.${r.t.status}`)}</Badge> },
                { key: "updated", header: ts("columns.updated"), priority: 2, className: "whitespace-nowrap text-xs", cell: (r) => formatDateTime(r.t.lastMessageAt, locale, "UTC") },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminSupportPage, "app/admin/support/page.tsx");
