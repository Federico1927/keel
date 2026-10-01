import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@keel/core";
import { SUPPORT_STATUSES, listSupportTickets } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { Chip } from "../notifications/tabs";
import { STATUS_VARIANT } from "./status";

export default async function SupportPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ status?: string }> }) {
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
      <div className="mb-4 flex flex-wrap gap-2">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.ticket")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.author")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.t.id} data-testid="ticket-row">
                    <TableCell>
                      <Link href={`${base}/${r.t.id}`} className="font-medium hover:underline">#{r.t.number} · {r.t.subject}</Link>
                      <p className="text-xs text-muted-foreground">{t(`categories.${r.t.category}`)} · {t("messages_n", { n: formatNumber(r.messages, ctx.locale) })}</p>
                    </TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[r.t.status] ?? "muted"}>{t(`statuses.${r.t.status}`)}</Badge></TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{r.authorName ?? r.authorEmail ?? "—"}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{formatDateTime(r.t.lastMessageAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
