import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { SUPPORT_STATUSES, listSupportTickets } from "@hullwise/services";
import { Badge, Card, CardContent, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { Chip } from "../notifications/tabs";
import { STATUS_VARIANT } from "./status";

import { withIntl } from "@/i18n/intl-scope";
async function SupportPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ status?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "support");
  const t = await getTranslations("support");
  const status = (SUPPORT_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const rows = await ctx.run((tx) => listSupportTickets({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { status }));
  const base = `/t/${tenant}/support`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0 [&>*]:shrink-0">
        <Chip href={base} active={!status}>{t("all")}</Chip>
        {SUPPORT_STATUSES.map((s) => (
          <Chip key={s} href={`${base}?status=${s}`} active={status === s}>{t(`statuses.${s}`)}</Chip>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.t.id}
              rowProps={() => ({ "data-testid": "ticket-row" })}
              columns={[
                { key: "ticket", header: t("columns.ticket"), mobile: "title", cell: (r) => <><Link href={`${base}/${r.t.id}`} className="font-medium hover:underline">#{r.t.number} · {r.t.subject}</Link><p className="text-xs font-normal text-muted-foreground">{t(`categories.${r.t.category}`)} · {t("messages_n", { n: formatNumber(r.messages, ctx.locale) })}</p></> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => <Badge variant={STATUS_VARIANT[r.t.status] ?? "muted"}>{t(`statuses.${r.t.status}`)}</Badge> },
                { key: "author", header: t("columns.author"), label: "", className: "text-sm", cell: (r) => r.authorName ?? r.authorEmail ?? "—" },
                { key: "updated", header: t("columns.updated"), label: "", className: "text-sm text-muted-foreground", cell: (r) => formatDateTime(r.t.lastMessageAt, ctx.locale, ctx.tenant.timezone) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(SupportPage, "app/t/[tenant]/support/page.tsx");
