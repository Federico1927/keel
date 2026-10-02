import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { displayName, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { adminDb, eq, schema } from "@hullwise/db";
import { operatorAttribution, operatorEfficiency, supervisorView } from "@hullwise/addon-cod";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { PeriodPicker } from "@/components/period-picker";
import { periodParams, resolvePeriod } from "@/server/period";
import { requirePage } from "@/server/tenant";

const TABS = ["supervisor", "efficiency", "attribution"] as const;

/**
 * Customer-care console of the add-on (C.11): who holds what now (supervisor), efficiency per
 * operator over a period, and what each operator handled with links to the orders. Supervisors
 * (owner, admin, operations) see the whole team; an operator sees their own rows.
 */
export default async function CodTeamPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; operator?: string; outcome?: string; preset?: string; from?: string; to?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "cod_queue");
  const t = await getTranslations("cod.team");
  const tcod = await getTranslations("cod");
  const supervisor = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "operations";
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : supervisor ? "supervisor" : "efficiency";
  const period = resolvePeriod(sp, ctx.tenant.timezone, "7d");
  const operatorId = supervisor ? (sp.operator && /^[0-9a-f-]{36}$/.test(sp.operator) ? sp.operator : null) : ctx.user.id;
  const outcome = sp.outcome === "confirmed" || sp.outcome === "cancelled" ? sp.outcome : undefined;
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const operators = members.filter((m) => ["owner", "admin", "operations", "customer_care"].includes(m.role));
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    if (tab === "supervisor" && supervisor) return { kind: "supervisor" as const, sup: await supervisorView(s) };
    if (tab === "attribution") return { kind: "attribution" as const, rows: operatorId ? await operatorAttribution(s, operatorId, period, { outcome }) : [] };
    return { kind: "efficiency" as const, eff: await operatorEfficiency(s, period, supervisor ? {} : { userId: ctx.user.id }) };
  });
  const base = `/t/${tenant}/cod/team`;
  const keep = periodParams(period, sp);
  const link = (p: Record<string, string | undefined>) => `${base}?${new URLSearchParams(Object.entries({ ...keep, tab, operator: operatorId ?? undefined, ...p }).filter((e): e is [string, string] => Boolean(e[1])))}`;
  const name = (u: { name: string | null; email: string | null } | undefined | null) => (u && (u.name || u.email) ? displayName(u) : tcod("unassigned"));
  const age = (h: number | null) => (h === null ? "—" : h >= 48 ? tcod("days_n", { n: Math.round(h / 24) }) : tcod("hours_n", { n: h }));
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/cod`} className="hover:underline">← {tcod("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={tab !== "supervisor" ? <PeriodPicker basePath={base} keep={{ tab, operator: operatorId ?? undefined, outcome }} preset={period.preset} from={sp.from} to={sp.to} /> : undefined} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm" role="tablist">
        {TABS.filter((x) => supervisor || x !== "supervisor").map((x) => (
          <Link key={x} href={link({ tab: x })} role="tab" aria-selected={tab === x} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", tab === x ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`team-tab-${x}`}>{t(`tabs.${x}`)}</Link>
        ))}
      </div>

      {data.kind === "supervisor" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("supervisor_title")}</CardTitle>
            <CardDescription>{t("supervisor_description", { avg: formatNumber(data.sup.teamAverage, ctx.locale) })}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tcod("columns.operator")}</TableHead>
                  <TableHead className="text-right">{t("to_call")}</TableHead>
                  <TableHead className="text-right">{t("overdue")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("never_contacted")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{tcod("views.planned")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{tcod("views.unreachable")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{tcod("views.escalated")}</TableHead>
                  <TableHead className="text-right">{t("oldest")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sup.rows.map((r) => (
                  <TableRow key={r.userId ?? "none"} data-testid="supervisor-row">
                    <TableCell>
                      {r.userId ? <Link href={link({ tab: "attribution", operator: r.userId })} className="hover:underline">{name(r)}</Link> : <span className="text-muted-foreground">{tcod("unassigned")}</span>}
                      {r.bottleneck && <Badge variant="destructive" className="ml-2" data-testid="bottleneck">{t("bottleneck")}</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular">{r.toCall}</TableCell>
                    <TableCell className={cn("text-right tabular", r.overdueCallBacks > 0 && "text-destructive")}>{r.overdueCallBacks}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.neverContacted}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.planned}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.unreachable}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.escalated}</TableCell>
                    <TableCell className="text-right tabular">{age(r.oldestHours)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data.kind === "efficiency" && (
        data.eff.length === 0 ? <EmptyState title={t("empty_title")} description={t("empty_description")} /> : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("efficiency_title")}</CardTitle>
              <CardDescription>{t("efficiency_description")}</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tcod("columns.operator")}</TableHead>
                    <TableHead className="text-right">{t("handled")}</TableHead>
                    <TableHead className="text-right">{tcod("outcomes.confirmed")}</TableHead>
                    <TableHead className="text-right">{t("confirmed_pct")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{tcod("outcomes.cancelled")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{tcod("columns.attempts")}</TableHead>
                    <TableHead className="text-right">{t("attempts_per_confirmation")}</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">{t("avg_handling")}</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">{t("throughput")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.eff.map((r) => (
                    <TableRow key={r.operatorId ?? "system"} data-testid="efficiency-row">
                      <TableCell>{r.operatorId ? <Link href={link({ tab: "attribution", operator: r.operatorId })} className="hover:underline">{name(r)}</Link> : <span className="text-muted-foreground">{t("system")}</span>}</TableCell>
                      <TableCell className="text-right tabular">{r.operatorId ? <Link href={link({ tab: "attribution", operator: r.operatorId, outcome: undefined })} className="hover:underline">{r.handled}</Link> : r.handled}</TableCell>
                      <TableCell className="text-right tabular">{r.operatorId ? <Link href={link({ tab: "attribution", operator: r.operatorId, outcome: "confirmed" })} className="hover:underline" data-testid="efficiency-confirmed">{r.confirmed}</Link> : r.confirmed}</TableCell>
                      <TableCell className="text-right tabular">{pct(r.confirmedPct)}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{r.cancelled}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{r.attempts}{r.messages ? <span className="text-xs text-muted-foreground"> ({t("messages_n", { n: r.messages })})</span> : null}</TableCell>
                      <TableCell className="text-right tabular">{r.attemptsPerConfirmation ?? "—"}</TableCell>
                      <TableCell className="hidden text-right tabular lg:table-cell">{r.avgHandlingMinutes === null ? "—" : r.avgHandlingMinutes >= 120 ? tcod("hours_n", { n: Math.round(r.avgHandlingMinutes / 60) }) : t("minutes_n", { n: r.avgHandlingMinutes })}</TableCell>
                      <TableCell className="hidden text-right tabular lg:table-cell">{r.closedPerDay === null ? "—" : t("per_day", { n: formatNumber(r.closedPerDay, ctx.locale) })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )
      )}

      {data.kind === "attribution" && (
        <Card>
          <CardHeader className="space-y-2">
            <CardTitle className="text-base">{t("attribution_title")}</CardTitle>
            {supervisor && (
              <div className="flex flex-wrap gap-1 text-sm" data-testid="operator-picker">
                {operators.map((o) => <Link key={o.id} href={link({ operator: o.id })} className={cn("rounded-full border px-3 py-1", operatorId === o.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground")}>{displayName(o)}</Link>)}
              </div>
            )}
            <div className="flex flex-wrap gap-1 text-xs">
              {([undefined, "confirmed", "cancelled"] as const).map((o) => <Link key={o ?? "all"} href={link({ outcome: o })} className={cn("rounded-full border px-2 py-0.5", outcome === o ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground")}>{o ? tcod(`outcomes.${o}`) : t("all_outcomes")}</Link>)}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {!operatorId ? <p className="p-4 text-sm text-muted-foreground">{t("pick_operator")}</p> : data.rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("empty_description")}</p> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tcod("columns.order")}</TableHead>
                    <TableHead className="hidden md:table-cell">{tcod("columns.customer")}</TableHead>
                    <TableHead className="text-right">{tcod("columns.total")}</TableHead>
                    <TableHead>{t("last_outcome")}</TableHead>
                    <TableHead className="text-right">{tcod("columns.attempts")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("last_at")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.orderId} data-testid="attribution-row">
                      <TableCell><Link href={`/t/${tenant}/orders/${r.orderId}`} className="font-medium hover:underline">{r.orderName}</Link></TableCell>
                      <TableCell className="hidden md:table-cell">{r.customerName ?? "—"}</TableCell>
                      <TableCell className="text-right tabular">{formatMoney(r.totalMinor, r.currency, ctx.locale)}</TableCell>
                      <TableCell><Badge variant={r.lastOutcome === "confirmed" ? "success" : r.lastOutcome === "cancelled" ? "destructive" : "outline"}>{tcod(`outcomes.${r.lastOutcome}`)}</Badge>{r.queueStatus && <span className="ml-1 text-xs text-muted-foreground">{tcod(`queue_status.${r.queueStatus}`)}</span>}</TableCell>
                      <TableCell className="text-right tabular">{r.attempts}</TableCell>
                      <TableCell className="hidden text-xs md:table-cell">{formatDateTime(r.lastAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
