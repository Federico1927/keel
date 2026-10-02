import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, displayName } from "@hullwise/core";
import { adminDb, eq, inArray, schema } from "@hullwise/db";
import { QUEUE_VIEWS, getCodSettings, operatorKpis, queueItems, queueTiles, rowAging, syncQueue, type QueueView } from "@hullwise/addon-cod";
import { getCommercePlatform } from "@/server/integrations";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, DataList, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { ClaimButton, OutcomeDialog, QueueToolbar, ScoreBadge } from "./queue-controls";
import { AutoRefresh, BulkBar, QueueSelection, SelectAll, SelectBox } from "./queue-extras";

const AGING_ROW = { fresh: undefined, warn: "bg-warning/10", alert: "bg-destructive/10" } as const;

export default async function CodQueuePage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ view?: string; q?: string; tag?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "cod_queue");
  const t = await getTranslations("cod");
  const view: QueueView = (QUEUE_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as QueueView) : "all";
  const canWrite = canWritePage(ctx.role, "cod_queue");
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const supervisor = canWrite && (isAdmin || ctx.role === "operations");
  const platform = await getCommercePlatform(ctx);
  const { rows, kpis, queueTags, tiles, settings } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const settings = await getCodSettings(s);
    await syncQueue(s, settings, { platform });
    const q = await queueItems(s, { view, userId: ctx.user.id, q: sp.q, tag: sp.tag });
    return { ...q, kpis: await operatorKpis(s, 7), queueTags: settings.tags.queue, tiles: await queueTiles(s, ctx.user.id), settings };
  });
  const tagFilter = sp.tag && queueTags.some((x) => x.toLowerCase() === sp.tag!.toLowerCase()) ? sp.tag.toLowerCase() : null;
  const members = supervisor ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id)) : [];
  const operators = members.filter((m) => ["owner", "admin", "operations", "customer_care"].includes(m.role)).map((m) => ({ id: m.id, label: displayName(m) }));
  const userIds = [...new Set(rows.map((r) => r.item.assignedTo).filter((x): x is string => Boolean(x)))];
  const users = userIds.length ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const who = (id: string | null) => (id ? (users.some((u) => u.id === id) ? displayName(users.find((u) => u.id === id)) : "—") : null);
  const base = `/t/${tenant}/cod`;
  const ctxQuery = `?queue=${view}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ""}`;
  const now = new Date();
  const fmtAge = (h: number | null) => (h === null ? "—" : h >= 48 ? t("days_n", { n: Math.round(h / 24) }) : t("hours_n", { n: h }));
  const decorated = rows.map((r) => ({ ...r, aging: rowAging(r.item, now, settings) }));
  const ageBadge = (a: (typeof decorated)[number]["aging"], status: string) =>
    a.neverContacted && status === "pending" ? <Badge variant={a.level === "alert" ? "destructive" : a.level === "warn" ? "warning" : "muted"} className="ml-1" data-testid="never-contacted">{t("never_contacted", { age: fmtAge(a.hours) })}</Badge> : null;
  type Row = (typeof decorated)[number];
  // one list: a table from md up, a card per order on phones (#49, replaces the separate C.16 cards)
  const table = (
    <DataList
      rows={decorated}
      rowKey={(r) => r.item.id}
      rowProps={({ item, aging }) => ({ "data-testid": "queue-row", "data-aging": aging.level, className: item.callBackAt && item.callBackAt <= now ? "bg-warning/10" : AGING_ROW[aging.level] })}
      columns={[
        {
          key: "order",
          header: <>{supervisor && <span className="mr-2 inline-block align-middle"><SelectAll orderIds={rows.map((r) => r.order.id)} label={t("bulk.select_all")} /></span>}{t("columns.order")}</>,
          mobile: "title",
          cell: ({ item, order }: Row) => {
            const overdue = item.callBackAt && item.callBackAt <= now;
            return (
              <>
                {supervisor && <span className="relative z-10"><SelectBox orderId={order.id} label={order.name} /></span>}
                <Link href={`/t/${tenant}/orders/${order.id}${ctxQuery}`} className="font-medium hover:underline">{order.name}</Link>
                <div className="text-xs font-normal text-muted-foreground">{formatDateTime(order.placedAt, ctx.locale, ctx.tenant.timezone)}</div>
                {item.entryTag && <Badge variant="secondary" className="mt-1" data-testid="entry-tag">{item.entryTag}</Badge>}
                {item.callBackAt && <Badge variant={overdue ? "warning" : "outline"} className="mt-1">{t("call_back_badge", { at: formatDateTime(item.callBackAt, ctx.locale, ctx.tenant.timezone) })}</Badge>}
                {item.scheduledConfirmOn && <Badge variant="info" className="mt-1" data-testid="planned-badge">{t("planned_badge", { date: formatDate(new Date(`${item.scheduledConfirmOn}T12:00:00Z`), ctx.locale, ctx.tenant.timezone) })}</Badge>}
                {item.scheduledConfirmError && <Badge variant="destructive" className="mt-1" title={item.scheduledConfirmError}>{t("planned_failed")}</Badge>}
                {item.escalatedAt && <Badge variant="destructive" className="mt-1" title={item.escalationReason ?? ""} data-testid="escalated-badge">{t("escalated")}</Badge>}
              </>
            );
          },
        },
        {
          key: "customer",
          header: t("columns.customer"),
          mobile: "subtitle",
          cell: ({ order }: Row) => (
            <>
              <div className="truncate max-md:text-foreground">{order.customerName ?? "—"}</div>
              <div className="text-xs text-muted-foreground">{order.phone ? <a href={`tel:${order.phone}`} className="text-primary underline-offset-4 hover:underline" data-testid="call-customer">{order.phone}</a> : (order.email ?? "—")} · {order.shippingCity ?? ""} {order.shippingCountry ?? ""}</div>
            </>
          ),
        },
        { key: "total", header: t("columns.total"), mobile: "badge", align: "right", className: "tabular", cell: ({ order }: Row) => formatMoney(order.totalMinor, order.currency, ctx.locale) },
        { key: "score", header: t("columns.score"), label: "", cell: ({ item }: Row) => <ScoreBadge score={item.score} tier={item.riskTier} /> },
        { key: "attempts", header: t("columns.attempts"), className: "tabular", cell: ({ item }: Row) => <>{item.attemptsCount}{item.status === "unreachable" && <Badge variant="destructive" className="ml-1">{t("views.unreachable")}</Badge>}</> },
        { key: "assigned", header: t("columns.assigned"), priority: 2, className: "text-xs", cell: ({ item }: Row) => who(item.assignedTo) ?? <span className="text-muted-foreground">{t("unassigned")}</span> },
        { key: "waiting", header: t("columns.waiting"), className: "text-xs tabular", cell: ({ item, aging }: Row) => <>{t("hours_n", { n: Math.round((now.getTime() - item.enteredAt.getTime()) / 3600e3) })}{ageBadge(aging, item.status)}</> },
        {
          key: "actions",
          header: "",
          mobile: "action",
          align: "right",
          cell: ({ item, order }: Row) => canWrite && (
            <span className="flex justify-end gap-1 max-md:[&>*]:flex-1">
              <ClaimButton slug={tenant} orderId={order.id} assignedToMe={item.assignedTo === ctx.user.id} assigned={Boolean(item.assignedTo)} canRelease={isAdmin || item.attemptsCount === 0} />
              <OutcomeDialog slug={tenant} orderId={order.id} orderName={order.name} compact />
            </span>
          ),
        },
      ]}
    />
  );
  return (
    <>
      <AutoRefresh />
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex flex-wrap items-center gap-2">{canWrite && <QueueToolbar slug={tenant} canDistribute={canWrite} />}<Link href={`${base}/team`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="team-link">{t("team_link")}</Link>{canWritePage(ctx.role, "cod_settings") && <Link href={`${base}/settings`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t("settings_link")}</Link>}</div>} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" data-testid="queue-tiles">
        {tiles.map((tile) => (
          <Link key={tile.view} href={`${base}?view=${tile.view}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ""}`} aria-current={view === tile.view ? "page" : undefined} className={cn("rounded-lg border bg-card p-3 text-sm shadow-sm transition-colors hover:bg-muted/40", view === tile.view && "border-primary ring-1 ring-primary")} data-testid={`queue-tile-${tile.view}`}>
            <span className="block truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(`views.${tile.view}`)}</span>
            <span className="block text-2xl font-semibold tabular" data-testid="tile-count">{formatNumber(tile.count, ctx.locale)}</span>
            <span className="block text-xs text-muted-foreground">{t("avg_age", { age: fmtAge(tile.avgAgeHours) })}</span>
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
        <QueueSelection>
          {supervisor && <BulkBar slug={tenant} operators={operators} />}
          <Card data-testid="queue-cards">
            <CardContent className="p-0">{table}</CardContent>
          </Card>
        </QueueSelection>
      )}
      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t("kpi_title")}</CardTitle>
          <Link href={`${base}/team?tab=efficiency`} className="text-xs text-muted-foreground hover:underline">{t("team_link")}</Link>
        </CardHeader>
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
                  <TableCell>{k.operatorId ? <Link href={`${base}/team?tab=attribution&operator=${k.operatorId}`} className="hover:underline">{k.name || k.email ? displayName(k) : "—"}</Link> : t("unassigned")}</TableCell>
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
