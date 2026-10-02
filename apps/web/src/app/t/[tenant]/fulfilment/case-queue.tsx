import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, type CaseKind } from "@keel/core";
import { countToShip, listShipmentCases, shipmentCaseCounts, type CaseScope } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, Input, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { StatusBadge } from "@/components/status-badge";
import { requirePage } from "@/server/tenant";
import { FulfilmentTabs } from "./tabs";

const SCOPES: CaseScope[] = ["open", "unclaimed", "mine", "closed"];

/** One work queue (delivery exceptions or returns to sender): server-side filters and pagination. */
export async function CaseQueue({ tenant, kind, sp }: { tenant: string; kind: CaseKind; sp: Record<string, string | string[] | undefined> }) {
  const ctx = await requirePage(tenant, "shipments");
  const t = await getTranslations("fulfilment_cases");
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
  const scope = (SCOPES as string[]).includes(one(sp.scope) ?? "") ? (one(sp.scope) as CaseScope) : "open";
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);
  const { list, counts, toShip } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { list: await listShipmentCases(s, { kind, scope, q, page }), counts: await shipmentCaseCounts(s), toShip: await countToShip(s) };
  });
  const segment = kind === "exception" ? "exceptions" : "returned";
  const base = `/t/${tenant}/fulfilment/${segment}`;
  const hrefFor = (p: number, sc = scope) => {
    const u = new URLSearchParams();
    if (sc !== "open") u.set("scope", sc);
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    return `${base}${u.size ? `?${u}` : ""}`;
  };
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t(`${segment}_title`)} description={t(`${segment}_description`)} />
      <FulfilmentTabs slug={tenant} active={segment} counts={{ toShip, exceptions: counts.exceptionsOpen, returned: counts.rtsOpen }} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {SCOPES.map((sc) => (
            <Link key={sc} href={hrefFor(1, sc)} data-testid={`scope-${sc}`} className={cn("rounded-full border px-3 py-1 text-xs", scope === sc ? "bg-primary text-primary-foreground" : "bg-card")}>
              {t(`scopes.${sc}`)}
            </Link>
          ))}
        </div>
        <form action={base} className="flex gap-2">
          {scope !== "open" && <input type="hidden" name="scope" value={scope} />}
          <Input name="q" defaultValue={q ?? ""} placeholder={t("search_placeholder")} aria-label={t("search")} className="sm:w-64" />
        </form>
      </div>
      {list.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t(`empty_${segment}`)} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead>{t("columns.shipment")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.opened")}</TableHead>
                  <TableHead>{t("columns.owner")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((r) => (
                  <TableRow key={r.id} data-testid="case-row" data-order={r.orderName}>
                    <TableCell>
                      <Link href={`/t/${tenant}/fulfilment/cases/${r.id}`} className="font-medium text-primary hover:underline">{r.orderName}</Link>
                      <p className="text-xs text-muted-foreground">{[r.customerName, r.country].filter(Boolean).join(" · ")}</p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{r.carrier ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{r.trackingNumber}</p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.shipmentStatus} namespace="shipment_status" />
                      {r.instructionSentAt && <Badge variant="info" className="ml-1">{t(`resolutions.${r.resolution ?? "redeliver"}`)}</Badge>}
                      {r.closedAt && <span className="block text-[10px] text-muted-foreground">{t(`close_reasons.${r.closeReason ?? "resolved"}`)}</span>}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{formatDateTime(r.openedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    <TableCell className="text-sm">{r.claimedBy ? (r.claimedBy === ctx.user.id ? t("you") : r.claimedByName) : <span className="text-muted-foreground">{t("unclaimed")}</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => hrefFor(p)} summary={t("pagination", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total })} />
    </>
  );
}
