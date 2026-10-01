import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatDateTime, formatMoney, formatNumber, displayName } from "@keel/core";
import { adminDb, eq, inArray, schema } from "@keel/db";
import { getCodSettings, operatorKpis, queueItems, syncQueue } from "@keel/addon-cod";
import { getCommercePlatform } from "@/server/integrations";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { ClaimButton, OutcomeDialog, QueueToolbar, ScoreBadge } from "./queue-controls";

const VIEWS = ["all", "mine", "unassigned", "scheduled", "unreachable"] as const;

export default async function CodQueuePage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ view?: string; q?: string; tag?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "cod_queue");
  const t = await getTranslations("cod");
  const view = (VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as (typeof VIEWS)[number]) : "all";
  const canWrite = canWritePage(ctx.role, "cod_queue");
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const platform = await getCommercePlatform(ctx);
  const { rows, counts, kpis, queueTags } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const settings = await getCodSettings(s);
    await syncQueue(s, settings, { platform });
    const q = await queueItems(s, { view, userId: ctx.user.id, q: sp.q, tag: sp.tag });
    return { ...q, kpis: await operatorKpis(s, 7), queueTags: settings.tags.queue };
  });
  const tagFilter = sp.tag && queueTags.some((t) => t.toLowerCase() === sp.tag!.toLowerCase()) ? sp.tag.toLowerCase() : null;
  const userIds = [...new Set(rows.map((r) => r.item.assignedTo).filter((x): x is string => Boolean(x)))];
  const users = userIds.length ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  void eq;
  const who = (id: string | null) => (id ? (users.some((u) => u.id === id) ? displayName(users.find((u) => u.id === id)) : "—") : null);
  const base = `/t/${tenant}/cod`;
  const now = new Date();
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex flex-wrap items-center gap-2">{canWrite && <QueueToolbar slug={tenant} canDistribute={canWrite} />}{canWritePage(ctx.role, "cod_settings") && <Link href={`${base}/settings`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t("settings_link")}</Link>}</div>} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
        {VIEWS.map((v) => (
          <Link key={v} href={`${base}?view=${v}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ""}`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", view === v ? "bg-card shadow-sm" : "text-muted-foreground")}>
            {t(`views.${v}`)} <span className="tabular opacity-70">{counts[v]}</span>
          </Link>
        ))}
      </div>
      {queueTags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1 text-sm" data-testid="tag-filter">
          <span className="mr-1 text-muted-foreground">{t("filter_by_tag")}</span>
          <Link href={`${base}?view=${view}`} className={cn("rounded-full border px-3 py-1", tagFilter ? "text-muted-foreground" : "bg-primary/10 font-medium text-primary")}>{t("all_tags")}</Link>
          {queueTags.map((tag) => (
            <Link key={tag} href={`${base}?view=${view}&tag=${encodeURIComponent(tag.toLowerCase())}`} className={cn("rounded-full border px-3 py-1", tagFilter === tag.toLowerCase() ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground")}>{tag}</Link>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead>{t("columns.customer")}</TableHead>
                  <TableHead className="text-right">{t("columns.total")}</TableHead>
                  <TableHead>{t("columns.score")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.attempts")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.assigned")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.waiting")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ item, order }) => {
                  const overdue = item.callBackAt && item.callBackAt <= now;
                  return (
                    <TableRow key={item.id} data-testid="queue-row" className={overdue ? "bg-warning/10" : undefined}>
                      <TableCell>
                        <Link href={`/t/${tenant}/orders/${order.id}`} className="font-medium hover:underline">{order.name}</Link>
                        <div className="text-xs text-muted-foreground">{formatDateTime(order.placedAt, ctx.locale, ctx.tenant.timezone)}</div>
                        {item.entryTag && <Badge variant="secondary" className="mt-1" data-testid="entry-tag">{item.entryTag}</Badge>}
                        {item.callBackAt && <Badge variant={overdue ? "warning" : "outline"} className="mt-1">{t("call_back_badge", { at: formatDateTime(item.callBackAt, ctx.locale, ctx.tenant.timezone) })}</Badge>}
                      </TableCell>
                      <TableCell>
                        <div className="truncate">{order.customerName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{order.phone ?? order.email ?? "—"} · {order.shippingCity ?? ""} {order.shippingCountry ?? ""}</div>
                      </TableCell>
                      <TableCell className="text-right tabular">{formatMoney(order.totalMinor, order.currency, ctx.locale)}</TableCell>
                      <TableCell><ScoreBadge score={item.score} tier={item.riskTier} /></TableCell>
                      <TableCell className="hidden md:table-cell tabular">{item.attemptsCount}{item.status === "unreachable" && <Badge variant="destructive" className="ml-1">{t("views.unreachable")}</Badge>}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{who(item.assignedTo) ?? <span className="text-muted-foreground">{t("unassigned")}</span>}</TableCell>
                      <TableCell className="hidden md:table-cell text-xs tabular">{t("hours_n", { n: Math.round((now.getTime() - item.enteredAt.getTime()) / 3600e3) })}</TableCell>
                      <TableCell className="text-right">
                        {canWrite && (
                          <span className="flex justify-end gap-1">
                            <ClaimButton slug={tenant} orderId={order.id} assignedToMe={item.assignedTo === ctx.user.id} assigned={Boolean(item.assignedTo)} canRelease={isAdmin || item.attemptsCount === 0} />
                            <OutcomeDialog slug={tenant} orderId={order.id} orderName={order.name} compact />
                          </span>
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
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("kpi_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.operator")}</TableHead>
                <TableHead className="text-right">{t("columns.attempts")}</TableHead>
                <TableHead className="text-right">{t("outcomes.confirmed")}</TableHead>
                <TableHead className="text-right">{t("outcomes.no_answer")}</TableHead>
                <TableHead className="text-right">{t("outcomes.cancelled")}</TableHead>
                <TableHead className="text-right">{t("confirmation_rate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpis.map((k) => (
                <TableRow key={k.operatorId ?? "none"}>
                  <TableCell>{k.name || k.email ? displayName(k) : t("unassigned")}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(k.attempts, ctx.locale)}</TableCell>
                  <TableCell className="text-right tabular">{k.confirmed}</TableCell>
                  <TableCell className="text-right tabular">{k.noAnswer}</TableCell>
                  <TableCell className="text-right tabular">{k.cancelled}</TableCell>
                  <TableCell className="text-right tabular">{k.attempts ? `${Math.round((100 * k.confirmed) / k.attempts)}%` : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
