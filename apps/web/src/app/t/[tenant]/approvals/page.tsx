import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isModuleInPlan } from "@hullwise/config";
import { formatDateTime, formatMoney } from "@hullwise/core";
import { canApproveProposal, listProposals, type ProposalRow } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, DataList } from "@hullwise/ui";
import { getTenantContext } from "@/server/tenant";
import { ProposalActions } from "./actions";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("mcp.approvals"))("title") };
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "info"> = { pending: "info", approved: "success", rejected: "muted", failed: "destructive", expired: "muted" };

/**
 * Approval inbox (#21): risky actions AI clients proposed through MCP (cancel, refund, pause a
 * campaign, a draft purchase order). Everyone sees them; only people whose role allows the action
 * can approve, and approving runs it as them.
 */
async function ApprovalsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await getTenantContext(tenant);
  if (!isModuleInPlan("core.mcp", ctx.tenant.planKey)) notFound();
  const t = await getTranslations("mcp.approvals");
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const [pending, decided] = await ctx.run(async (tx) => [await listProposals({ ...s, tx }, { view: "pending" }), await listProposals({ ...s, tx }, { view: "decided", limit: 30 })] as const);
  const tz = ctx.user.timeZone ?? ctx.tenant.timezone;
  const money = (minor: unknown, currency: unknown) => (typeof minor === "number" && typeof currency === "string" ? formatMoney(minor, currency, ctx.locale) : "—");
  const target = (p: ProposalRow) => {
    const sm = p.summary;
    if (p.kind === "order.cancel" || p.kind === "order.refund") return <Link href={`/t/${tenant}/orders/${p.entityId}`} className="font-medium hover:underline">{String(sm.orderName ?? "—")}</Link>;
    if (p.kind === "campaign.pause") return <Link href={`/t/${tenant}/campaigns/${p.entityId}`} className="font-medium hover:underline">{String(sm.campaignName ?? "—")}</Link>;
    return <span className="font-medium">{String(sm.supplierName ?? "—")}</span>;
  };
  const kind = (k: string) => t(`kinds.${k.replace(".", "_")}`);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        {pending.length === 0 && <EmptyState title={t("empty_title")} description={t("empty_description")} />}
        <div className="grid gap-4 lg:grid-cols-2" data-testid="proposals-pending">
          {pending.map((p) => (
            <Card key={p.id} data-testid="proposal-card">
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="info">{kind(p.kind)}</Badge>
                  {target(p)}
                </div>
                <CardDescription>{t("requested_by", { client: p.clientName ?? "AI", user: p.requestedByName ?? "—", when: formatDateTime(p.createdAt, ctx.locale, tz) })}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {p.reason && <blockquote className="border-l-2 pl-3 italic text-muted-foreground">“{p.reason}”</blockquote>}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  {p.kind === "order.cancel" && (
                    <>
                      <dt className="text-muted-foreground">{t("order_total")}</dt>
                      <dd>{money(p.summary.totalMinor, p.summary.currency)}</dd>
                      <dt className="text-muted-foreground">{t("restock")}</dt>
                      <dd>{p.summary.restock ? t("yes") : t("no")}</dd>
                      <dt className="text-muted-foreground">{t("refund")}</dt>
                      <dd>{p.summary.refund ? t("yes") : t("no")}</dd>
                    </>
                  )}
                  {p.kind === "order.refund" && (
                    <>
                      <dt className="text-muted-foreground">{t("amount")}</dt>
                      <dd>{money(p.summary.amountMinor, p.summary.currency)}</dd>
                      <dt className="text-muted-foreground">{t("refundable")}</dt>
                      <dd>{money(p.summary.refundableMinor, p.summary.currency)}</dd>
                    </>
                  )}
                  {p.kind === "purchase_order.create" && (
                    <>
                      <dt className="text-muted-foreground">{t("lines")}</dt>
                      <dd>{(Array.isArray(p.summary.lines) ? (p.summary.lines as { sku: string; quantity: number }[]) : []).map((l) => `${l.sku} × ${l.quantity}`).join(", ")}</dd>
                      <dt className="text-muted-foreground">{t("amount")}</dt>
                      <dd>{money(p.summary.totalMinor, p.summary.currency)}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{t("expires")}</dt>
                  <dd>{formatDateTime(p.expiresAt, ctx.locale, tz)}</dd>
                </dl>
                {canApproveProposal(ctx.role, p.kind) ? <ProposalActions slug={tenant} id={p.id} /> : <p className="text-xs text-muted-foreground">{t("cannot_approve")}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("history")}</CardTitle>
          </CardHeader>
          <CardContent>
            {decided.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("history_empty")}</p>
            ) : (
              <DataList
                data-testid="proposals-history"
                rows={decided}
                rowKey={(p) => p.id}
                columns={[
                  { key: "proposal", header: t("col_proposal"), mobile: "title", cell: (p) => <><div className="text-xs font-normal text-muted-foreground">{kind(p.kind)}</div>{target(p)}</> },
                  { key: "requested", header: t("col_requested"), mobile: "subtitle", className: "text-sm", cell: (p) => <>{p.clientName ?? "AI"} · {p.requestedByName ?? "—"}<div className="text-xs text-muted-foreground max-md:ml-1 max-md:inline">{formatDateTime(p.createdAt, ctx.locale, tz)}</div></> },
                  { key: "status", header: t("col_status"), mobile: "badge", cell: (p) => <><Badge variant={STATUS_VARIANT[p.status] ?? "muted"}>{t(`status.${p.status}`)}</Badge>{p.error && <div className="mt-1 text-xs text-destructive">{p.error}</div>}</> },
                  { key: "decided", header: t("col_decided"), className: "text-sm", cell: (p) => <>{p.decidedByName ?? "—"}{p.decisionNote && <div className="text-xs italic text-muted-foreground">“{p.decisionNote}”</div>}</> },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default withIntl(ApprovalsPage, "app/t/[tenant]/approvals/page.tsx");
