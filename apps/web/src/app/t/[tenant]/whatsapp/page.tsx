import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME, canDo, canViewPage, canWritePage } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { listSpokiConversations, spokiConversation } from "@hullwise/addon-spoki";
import { getCodSettings } from "@hullwise/addon-cod";
import { and, eq, schema } from "@hullwise/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, Pagination, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { VARIANT, simulatedCodReplies } from "@/components/whatsapp-log";
import { WhatsappSimulate, WhatsappSimulateInbound } from "@/components/whatsapp-simulate";
import { WhatsappTabs } from "./tabs";
import { ReplyForm } from "./reply-form";

import { withIntl } from "@/i18n/intl-scope";

const PAGE_SIZE = 30;

/**
 * WhatsApp conversations of the Spoki add-on (issue #9): the message log grouped by customer, the
 * threads where the customer wrote last first in the "Awaiting reply" filter, and one thread with
 * the 24-hour window and the team's free-text answer. In mock mode the customer's side can be
 * simulated (receipts, replies, a message of their own) through the real webhook route.
 */
async function WhatsappConversationsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ thread?: string; filter?: string; page?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "whatsapp_settings");
  const t = await getTranslations("whatsapp.conversations");
  const tl = await getTranslations("whatsapp.log");
  const awaitingOnly = sp.filter === "awaiting";
  const page = Math.max(1, Number(sp.page) || 1);
  const threadId = sp.thread && /^[0-9a-f-]{36}$/i.test(sp.thread) ? sp.thread : null;
  const { list, thread, mock, codReplies } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [row] = await tx.select({ mode: schema.integrations.mode }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1);
    // replies the COD queue acts on by itself (confirm, or escalate to its own team) are not waiting for a WhatsApp answer
    const codKeywords = ctx.activeAddons.includes("addon.cod") ? (await getCodSettings(s)).messagingReplies : null;
    return { list: await listSpokiConversations(s, { awaitingOnly, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, autoReplies: codKeywords ? [...codKeywords.confirm, ...codKeywords.cancel] : [] }), thread: threadId ? await spokiConversation(s, threadId) : null, mock: integrationMode() === "mock" || row?.mode !== "live", codReplies: await simulatedCodReplies(ctx, s) };
  });
  const base = `/t/${tenant}/whatsapp`;
  const href = (q: { thread?: string | null; filter?: string | null; page?: number }) => {
    const u = new URLSearchParams();
    const filter = q.filter === undefined ? (awaitingOnly ? "awaiting" : null) : q.filter;
    if (filter) u.set("filter", filter);
    if ((q.page ?? page) > 1) u.set("page", String(q.page ?? page));
    if (q.thread) u.set("thread", q.thread);
    const qs = u.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const when = (d: Date) => formatDateTime(d, ctx.locale, ctx.tenant.timezone);
  const canSimulate = mock && canDo(ctx.role, "manage_integrations");
  const canReply = canWritePage(ctx.role, "whatsapp_settings");
  const canCustomers = canViewPage(ctx.role, "customers");
  const canOrders = canViewPage(ctx.role, "orders");
  const purpose = (p: string) => (tl.has(`purpose.${p}`) ? tl(`purpose.${p}`, { product: PRODUCT_NAME }) : p);
  const name = (c: { customerName: string | null; phone: string }) => c.customerName ?? c.phone;
  const filters = (
    <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" data-testid="conversation-filters">
      <Link href={href({ filter: null, page: 1 })} className={cn("flex-1 rounded-sm px-3 py-1 text-center", !awaitingOnly ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid="filter-all">{t("filter_all")}</Link>
      <Link href={href({ filter: "awaiting", page: 1 })} className={cn("flex-1 rounded-sm px-3 py-1 text-center", awaitingOnly ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid="filter-awaiting">{t("filter_awaiting", { n: formatNumber(list.awaiting, ctx.locale) })}</Link>
    </div>
  );
  const lastOutbound = thread ? [...thread.messages].reverse().find((r) => r.m.direction === "outbound" && r.m.providerMessageId) : undefined;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <WhatsappTabs tenant={tenant} active="conversations" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className={cn(thread && "max-lg:hidden")} data-testid="conversation-list">
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">{t("list_title")}</CardTitle>
            {filters}
          </CardHeader>
          <CardContent className="p-0">
            {list.rows.length === 0 ? (
              <div className="p-6"><EmptyState title={awaitingOnly ? t("empty_awaiting_title") : t("empty_title")} description={awaitingOnly ? t("empty_awaiting_description") : t("empty_description")} /></div>
            ) : (
              <DataList
                rows={list.rows}
                rowKey={(r) => r.phone}
                rowProps={(r) => ({ "data-testid": "conversation-row", "data-awaiting": r.awaitingReply ? "1" : "0", className: thread?.phone === r.phone ? "bg-muted/60" : undefined })}
                columns={[
                  { key: "who", header: t("columns.customer"), mobile: "title", cell: (r) => <><Link href={href({ thread: r.lastMessageId })} className="font-medium hover:underline" data-testid="conversation-link">{name(r)}</Link><div className="line-clamp-1 text-xs font-normal text-muted-foreground">{r.lastDirection === "inbound" ? "↩ " : ""}{r.lastBody ?? purpose(r.lastPurpose)}</div></> },
                  { key: "state", header: t("columns.state"), mobile: "badge", cell: (r) => (r.awaitingReply ? <Badge variant="warning" data-testid="awaiting-badge">{t("awaiting")}</Badge> : <Badge variant={VARIANT[r.lastStatus] ?? "outline"}>{tl(`status.${r.lastStatus}`)}</Badge>) },
                  { key: "last", header: t("columns.last"), align: "right", className: "tabular text-xs text-muted-foreground", cell: (r) => when(r.lastAt) },
                ]}
              />
            )}
            <div className="p-4"><Pagination page={page} pageSize={PAGE_SIZE} total={list.total} hrefFor={(p) => href({ page: p })} summary={t("summary", { n: formatNumber(list.total, ctx.locale) })} /></div>
          </CardContent>
        </Card>

        {thread ? (
          <Card data-testid="conversation-thread">
            <CardHeader>
              <p className="text-sm lg:hidden"><Link href={href({ thread: null })} className="hover:underline" data-testid="thread-back">← {t("back")}</Link></p>
              <CardTitle className="text-base">
                {thread.customer && canCustomers ? <Link href={`/t/${tenant}/customers/${thread.customer.id}`} className="hover:underline">{[thread.customer.firstName, thread.customer.lastName].filter(Boolean).join(" ") || thread.phone}</Link> : ([thread.customer?.firstName, thread.customer?.lastName].filter(Boolean).join(" ") || thread.phone)}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2">
                <span className="tabular">{thread.phone}</span>
                <Badge variant={thread.windowOpen ? "success" : "muted"} data-testid="window-badge" data-open={thread.windowOpen ? "1" : "0"}>{thread.windowOpen && thread.lastInboundAt ? t("window_open", { at: when(new Date(thread.lastInboundAt.getTime() + 24 * 3600e3)) }) : t("window_closed")}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="space-y-2" data-testid="thread-messages">
                {thread.messages.map(({ m, orderName, sender }) => (
                  <li key={m.id} className={cn("flex", m.direction === "inbound" ? "justify-start" : "justify-end")} data-testid="thread-message" data-direction={m.direction} data-status={m.status}>
                    <div className={cn("max-w-[85%] rounded-lg px-3 py-2 text-sm", m.direction === "inbound" ? "bg-muted" : "border bg-primary/5")}>
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{purpose(m.purpose)}</span>
                        {m.direction === "outbound" && <Badge variant={VARIANT[m.status] ?? "outline"}>{tl(`status.${m.status}`)}</Badge>}
                        {m.templateName && <span className="font-mono">{m.templateName}</span>}
                        {orderName && m.orderId && (canOrders ? <Link href={`/t/${tenant}/orders/${m.orderId}`} className="underline-offset-4 hover:underline">{orderName}</Link> : <span>{orderName}</span>)}
                      </div>
                      {m.body && <p className="whitespace-pre-line break-words">{m.body}</p>}
                      {m.status === "failed" && (m.errorMessage || m.errorCode) && <p className="mt-1 text-xs text-destructive">{m.errorCode ? `${m.errorCode} · ` : ""}{m.errorMessage ?? ""}</p>}
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
                        {sender && <span>{sender}</span>}
                        <span className="tabular">{when(m.occurredAt)}</span>
                        {canSimulate && m.direction === "outbound" && m.providerMessageId && m.status !== "failed" && <WhatsappSimulate slug={tenant} messageId={m.providerMessageId} replies={m.purpose === "cod" && codReplies.length ? codReplies : [tl("sample_question")]} />}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              {canSimulate && lastOutbound?.m.providerMessageId && (
                <div className="space-y-1 rounded-md border border-dashed p-3">
                  <p className="text-xs text-muted-foreground">{t("simulate_hint")}</p>
                  <WhatsappSimulateInbound slug={tenant} messageId={lastOutbound.m.providerMessageId} placeholder={t("simulate_placeholder")} />
                </div>
              )}
              {canReply && <ReplyForm slug={tenant} messageId={thread.messages.at(-1)?.m.id ?? threadId!} windowOpen={thread.windowOpen} />}
            </CardContent>
          </Card>
        ) : (
          <Card className="max-lg:hidden" data-testid="conversation-placeholder">
            <CardContent className="p-6"><EmptyState title={t("pick_title")} description={t("pick_description")} /></CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

export default withIntl(WhatsappConversationsPage, "app/t/[tenant]/whatsapp/page.tsx");
