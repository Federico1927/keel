import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { READY_MADE_SUBSCRIPTION_SEGMENTS, formatDate, formatMoney, readyMadeSubscriptionSegment } from "@hullwise/core";
import { listSubscribers, parseSubscriberFilters } from "@hullwise/services";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { encodeRulesParam } from "@/server/queries/crm";
import { RiskBadge, SubscriptionStatusBadge, SubscriptionTabs, intervalFormatter, svcOf } from "../shared";

/** Subscribers (addon.subscriptions): server-side filters and pagination; cards on mobile, a table from `md`. */
export default async function SubscribersPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "subscriptions");
  const t = await getTranslations("subscriptions");
  const f = parseSubscriberFilters(sp);
  const data = await ctx.run((tx) => listSubscribers(svcOf(ctx, tx), f, { timezone: ctx.tenant.timezone }));
  const every = await intervalFormatter();
  const base = `/t/${tenant}/subscriptions/subscribers`;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const date = (d: Date | null) => (d ? formatDate(d, ctx.locale, ctx.tenant.timezone) : "—");
  const query = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "page") q.set(k, v);
    for (const [k, v] of Object.entries(patch)) if (v) q.set(k, v); else q.delete(k);
    return q.toString();
  };
  const filtered = Object.keys(sp).some((k) => k !== "page" && sp[k]);
  const segments = canWritePage(ctx.role, "segments");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("subscribers.title")} description={t("subscribers.description")} />
      <SubscriptionTabs tenant={tenant} active="subscribers" />
      <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
        <Input name="q" defaultValue={f.q ?? ""} placeholder={t("subscribers.search")} aria-label={t("subscribers.search")} className="w-56" />
        <Select name="status" defaultValue={f.status?.join(",") ?? ""} aria-label={t("subscribers.status")} className="w-40">
          <option value="">{t("subscribers.all_statuses")}</option>
          {["active", "paused", "cancelled", "failed"].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          <option value="active,paused">{t("subscribers.live")}</option>
        </Select>
        <Select name="risk" defaultValue={f.risk ?? ""} aria-label={t("subscribers.risk")} className="w-40">
          <option value="">{t("subscribers.any_risk")}</option>
          {["high", "medium", "low"].map((r) => <option key={r} value={r}>{t(`risk.${r}`)}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="failing" value="1" defaultChecked={f.failing} />{t("subscribers.failing")}</label>
        <Button type="submit" size="sm">{t("subscribers.apply")}</Button>
        {filtered && <Link href={base} className="text-sm text-muted-foreground hover:underline">{t("subscribers.clear")}</Link>}
      </form>
      {(f.cohort || f.movement || f.reason || f.variant || f.kind || f.activatedFrom || f.endedFrom) && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="subscriber-drilldown">{[f.cohort && t("subscribers.f_cohort", { v: f.cohort }), f.movement && t("subscribers.f_movement", { month: f.movement.split(":")[0]!, bucket: t(`movement.${f.movement.split(":")[1]}`) }), f.reason && t("subscribers.f_reason", { v: f.reason }), f.kind && t(`subscribers.f_${f.kind}`), f.activatedFrom && t("subscribers.f_activated", { from: f.activatedFrom }), f.endedFrom && t("subscribers.f_ended", { from: f.endedFrom })].filter(Boolean).join(" · ")}</p>
      )}
      {data.rows.length === 0 ? <EmptyState title={t("subscribers.empty_title")} description={t("subscribers.empty_description")} /> : (
        <>
          <ul className="space-y-2 md:hidden" data-testid="subscriber-cards">
            {data.rows.map((r) => (
              <li key={r.id}>
                <Link href={`${base}/${r.id}`} className="block rounded-lg border bg-card p-3 shadow-sm" data-testid="subscriber-card">
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.customerName ?? r.email ?? "—"}</span><SubscriptionStatusBadge status={r.status} /></div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">{r.products}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"><span className="font-medium tabular">{money(r.priceMinor)} · {every(r.intervalUnit, r.intervalCount)}</span><span className="text-muted-foreground">{t("subscribers.next", { date: date(r.nextBillingAt) })}</span><RiskBadge risk={r.churnRisk} />{r.paymentFailingSince && <span className="text-destructive">{t("subscribers.payment_failing")}</span>}</div>
                </Link>
              </li>
            ))}
          </ul>
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table data-testid="subscriber-table">
                <TableHeader><TableRow><TableHead>{t("subscribers.customer")}</TableHead><TableHead>{t("subscribers.products")}</TableHead><TableHead>{t("subscribers.status")}</TableHead><TableHead className="text-right">{t("subscribers.price")}</TableHead><TableHead className="hidden lg:table-cell">{t("subscribers.frequency")}</TableHead><TableHead>{t("subscribers.next_billing")}</TableHead><TableHead className="hidden text-right lg:table-cell">{t("subscribers.renewals")}</TableHead><TableHead>{t("subscribers.risk")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id} data-testid="subscriber-row">
                      <TableCell className="max-w-48"><Link href={`${base}/${r.id}`} className="block truncate font-medium hover:underline">{r.customerName ?? r.email ?? "—"}</Link><span className="block truncate text-xs text-muted-foreground">{r.email}</span></TableCell>
                      <TableCell className="max-w-64 truncate text-sm">{r.products}</TableCell>
                      <TableCell><SubscriptionStatusBadge status={r.status} />{r.paymentFailingSince && <span className="ml-1 text-xs text-destructive">{t("subscribers.payment_failing")}</span>}</TableCell>
                      <TableCell className="text-right tabular">{money(r.priceMinor)}</TableCell>
                      <TableCell className="hidden text-sm lg:table-cell">{every(r.intervalUnit, r.intervalCount)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{r.endedAt ? <span className="text-muted-foreground">{t("subscribers.ended", { date: date(r.endedAt) })}</span> : date(r.nextBillingAt)}</TableCell>
                      <TableCell className="hidden text-right tabular lg:table-cell">{r.renewals}</TableCell>
                      <TableCell><RiskBadge risk={r.churnRisk} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => `${base}?${query({ page: String(p) })}`} summary={t("subscribers.summary", { n: data.total })} />
        </>
      )}
      <Card className="mt-6" data-testid="ready-segments">
        <CardHeader><CardTitle className="text-base">{t("ready.title")}</CardTitle><CardDescription>{t("ready.description")}</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {READY_MADE_SUBSCRIPTION_SEGMENTS.map((k) => segments ? <Link key={k} href={`/t/${tenant}/segments/new?rules=${encodeRulesParam(readyMadeSubscriptionSegment(k, { renewal: 3 }))}`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid={`ready-${k}`}>{t(`ready.${k}`)}</Link> : <span key={k} className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground">{t(`ready.${k}`)}</span>)}
        </CardContent>
      </Card>
    </>
  );
}
