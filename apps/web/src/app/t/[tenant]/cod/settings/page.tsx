import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, displayName } from "@keel/core";
import { adminDb, eq, schema } from "@keel/db";
import { SCORE_FACTORS, TAG_WRITE_EVENTS, getCodSettings, listCapacity, listRiskyRecipients } from "@keel/addon-cod";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { CapacityRow, DeleteExceptionButton, ExceptionForm, OverrideControls, RecomputeRiskButton, ScoringSettingsForm, TagSettingsForm } from "./controls";

export default async function CodSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "cod_settings");
  const t = await getTranslations("cod.settings");
  const tcod = await getTranslations("cod");
  const { settings, capacity, risky } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { settings: await getCodSettings(s), capacity: await listCapacity(s), risky: await listRiskyRecipients(s, { tiers: ["watch", "high_risk", "blacklisted"], limit: 100 }) };
  });
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const operators = members.filter((m) => ["operations", "customer_care", "admin", "owner"].includes(m.role)).map((m) => ({ id: m.id, label: displayName(m) }));
  const mask = (k: string) => (k.startsWith("email:") ? k.replace(/^email:(.{2}).*(@.*)$/, "email:$1***$2") : k.replace(/\d(?=\d{3})/g, "•"));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/cod`} className="hover:underline">← {tcod("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("operators_title")}</CardTitle>
            <CardDescription>{t("operators_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-2">{t("operator")}</th>
                    {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d) => <th key={d} className="px-1 py-2 text-center">{t(`days.${d}`)}</th>)}
                    <th className="px-3 py-2 text-right">{t("week")}</th>
                    <th className="px-3 py-2">{t("allowed_tags")}</th>
                    <th className="px-3 py-2 text-right">{t("active")}</th>
                  </tr>
                </thead>
                <tbody>
                  {operators.map((o) => {
                    const cap = capacity.operators.find((c) => c.userId === o.id);
                    return <CapacityRow key={o.id} slug={tenant} userId={o.id} label={o.label} dailyHours={cap?.dailyHours ?? [0, 0, 0, 0, 0, 0, 0]} isActive={cap ? cap.isActive === 1 : false} allowedTags={cap?.allowedTags ?? []} />;
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">{t("exceptions_title")}</p>
              <ExceptionForm slug={tenant} operators={operators} />
              {capacity.exceptions.length > 0 && (
                <ul className="mt-2 divide-y text-sm">
                  {capacity.exceptions.map((e) => (
                    <li key={e.id} className="flex items-center justify-between py-1">
                      <span>{formatDate(new Date(`${e.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone)} · {operators.find((o) => o.id === e.userId)?.label ?? e.userId.slice(0, 8)} · <Badge variant={e.kind === "off" ? "muted" : "info"}>{t(`kinds.${e.kind}`)}{e.hours ? ` ${e.hours}h` : ""}</Badge> {e.note && <span className="text-muted-foreground">{e.note}</span>}</span>
                      <DeleteExceptionButton slug={tenant} id={e.id} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
        <TagSettingsForm slug={tenant} settings={settings} events={TAG_WRITE_EVENTS} />
        <ScoringSettingsForm slug={tenant} settings={settings} factors={SCORE_FACTORS} />
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{t("recipients_title")}</CardTitle>
              <CardDescription>{t("recipients_description")}</CardDescription>
            </div>
            <RecomputeRiskButton slug={tenant} />
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("recipient")}</TableHead>
                  <TableHead>{t("tier")}</TableHead>
                  <TableHead className="text-right">{t("returns")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("delivered")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("last_return")}</TableHead>
                  <TableHead>{t("suggestion")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {risky.map((r) => (
                  <TableRow key={r.id} data-testid="risk-row">
                    <TableCell className="font-mono text-xs">{mask(r.recipientKey)}</TableCell>
                    <TableCell><Badge variant={r.tier === "blacklisted" ? "destructive" : r.tier === "high_risk" ? "warning" : "muted"}>{tcod(`risk.${r.tier}`)}</Badge>{r.override && <Badge variant="outline" className="ml-1">{t(`overrides.${r.override}`)}</Badge>}</TableCell>
                    <TableCell className="text-right tabular">{r.ordersReturned} <span className="text-xs text-muted-foreground">({r.weightedReturns})</span></TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.ordersDelivered}</TableCell>
                    <TableCell className="hidden md:table-cell">{r.lastReturnAt ? formatDate(r.lastReturnAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                    <TableCell className="text-xs">{r.tier === "blacklisted" && r.override !== "force_blacklist" ? t("suggest_blacklist") : r.tier === "high_risk" ? t("suggest_verify") : "—"}</TableCell>
                    <TableCell><OverrideControls slug={tenant} recipientKey={r.recipientKey} override={r.override} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
