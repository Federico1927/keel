import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, type CaseKind } from "@hullwise/core";
import { countToShip, listShipmentCases, shipmentCaseCounts, type CaseScope } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, Input, PageHeader, Pagination, DataList, cn } from "@hullwise/ui";
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
            <Link key={sc} href={hrefFor(1, sc)} data-testid={`scope-${sc}`} className={cn("rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9 pointer-coarse:py-2", scope === sc ? "bg-primary text-primary-foreground" : "bg-card")}>
              {t(`scopes.${sc}`)}
            </Link>
          ))}
        </div>
        <form action={base} className="flex gap-2">
          {scope !== "open" && <input type="hidden" name="scope" value={scope} />}
          <Input type="search" enterKeyHint="search" name="q" defaultValue={q ?? ""} placeholder={t("search_placeholder")} aria-label={t("search")} className="sm:w-64" />
        </form>
      </div>
      {list.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t(`empty_${segment}`)} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={list.rows}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "case-row", "data-order": r.orderName })}
              columns={[
                { key: "order", header: t("columns.order"), mobile: "title", cell: (r) => <><Link href={`/t/${tenant}/fulfilment/cases/${r.id}`} className="font-medium text-primary hover:underline">{r.orderName}</Link><p className="text-xs font-normal text-muted-foreground">{[r.customerName, r.country].filter(Boolean).join(" · ")}</p></> },
                { key: "shipment", header: t("columns.shipment"), mobile: "subtitle", cell: (r) => <><p className="text-sm max-md:inline max-md:text-foreground">{r.carrier ?? "—"}</p>{" "}<p className="text-xs text-muted-foreground max-md:inline">{r.trackingNumber}</p></> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => <><StatusBadge status={r.shipmentStatus} namespace="shipment_status" />{r.instructionSentAt && <Badge variant="info" className="ml-1">{t(`resolutions.${r.resolution ?? "redeliver"}`)}</Badge>}{r.closedAt && <span className="block text-[10px] text-muted-foreground">{t(`close_reasons.${r.closeReason ?? "resolved"}`)}</span>}</> },
                { key: "opened", header: t("columns.opened"), className: "text-sm text-muted-foreground", cell: (r) => formatDateTime(r.openedAt, ctx.locale, ctx.tenant.timezone) },
                { key: "owner", header: t("columns.owner"), className: "text-sm", cell: (r) => (r.claimedBy ? (r.claimedBy === ctx.user.id ? t("you") : r.claimedByName) : <span className="text-muted-foreground">{t("unclaimed")}</span>) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => hrefFor(p)} summary={t("pagination", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total })} />
    </>
  );
}
