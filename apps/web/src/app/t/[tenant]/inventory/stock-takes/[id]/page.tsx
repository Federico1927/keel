import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { InventoryControlError, stockTakeDetail } from "@hullwise/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Stat, DataList, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { svcOf } from "@/server/queries/inventory-control";
import { CountEditor, StockTakeActions, StockTakeScanner } from "../controls";

import { withIntl } from "@/i18n/intl-scope";
const STATUS_BADGE = { match: "success", missing: "destructive", surplus: "warning", unknown: "muted" } as const;

async function StockTakePage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant, id } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "inventory");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("inventory_control");
  const detail = await ctx.run((tx) => stockTakeDetail(svcOf(ctx, tx), id)).catch((e: unknown) => (e instanceof InventoryControlError ? null : Promise.reject(e)));
  if (!detail) notFound();
  const { take, locationName, lines, summary } = detail;
  const open = take.status === "open";
  const canWrite = open && canWritePage(ctx.role, "inventory");
  const filter = typeof sp.status === "string" && ["match", "missing", "surplus", "unknown"].includes(sp.status) ? sp.status : null;
  const shown = filter ? lines.filter((l) => l.status === filter) : lines;
  const differences = summary.missing + summary.surplus;
  const base = `/t/${tenant}/inventory/stock-takes/${id}`;
  const n = (v: number) => formatNumber(v, ctx.locale);
  return (
    <>
      <Link href={`/t/${tenant}/inventory/stock-takes`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("stock_takes.back")}
      </Link>
      <PageHeader
        eyebrow={`${ctx.tenant.name} · ${locationName}`}
        title={`ST-${take.number}`}
        description={open ? t("stock_takes.open_description") : take.status === "applied" ? t("stock_takes.applied_description", { at: formatDateTime(take.appliedAt!, ctx.locale, ctx.tenant.timezone), n: take.appliedMovements ?? 0 }) : t("stock_takes.cancelled_description")}
        actions={<Badge variant={open ? "info" : take.status === "applied" ? "success" : "muted"} data-testid="stock-take-status">{t(`stock_takes.status.${take.status}`)}</Badge>}
      />
      {take.note && <p className="-mt-4 mb-4 text-sm text-muted-foreground">{take.note}</p>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(["missing", "surplus", "unknown", "match"] as const).map((k) => (
          <Stat key={k} label={t(`stock_takes.review.${k}`)} value={n(summary[k])} hint={k === "missing" ? t("stock_takes.units", { n: summary.unitsMissing }) : k === "surplus" ? t("stock_takes.units", { n: summary.unitsSurplus }) : undefined} href={`${base}?status=${k}`} className={cn(filter === k && "ring-2 ring-ring")} />
        ))}
      </div>
      {canWrite && (
        <Card className="mb-4">
          <CardContent className="space-y-4 pt-6">
            <StockTakeScanner slug={tenant} stockTakeId={id} />
            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{t("stock_takes.apply_hint")}</p>
              <StockTakeActions slug={tenant} stockTakeId={id} differences={differences} />
            </div>
          </CardContent>
        </Card>
      )}
      <Card data-testid="stock-take-review">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t("stock_takes.review_title")}</CardTitle>
          {filter && <Link href={base} className="text-sm text-primary hover:underline">{t("stock_takes.show_all")}</Link>}
        </CardHeader>
        <CardContent className="p-0">
          {shown.length === 0 ? (
            <EmptyState title={t("stock_takes.no_lines")} description={open ? t("stock_takes.no_lines_hint") : undefined} />
          ) : (
            <DataList
              rows={shown}
              rowKey={(l) => l.id}
              rowProps={(l) => ({ "data-testid": "stock-take-line", "data-status": l.status })}
              columns={[
                { key: "variant", header: t("stock_takes.columns.variant"), mobile: "title", cell: (l) => <>{l.productId ? <Link href={`/t/${tenant}/products/${l.productId}`} className="font-medium text-primary hover:underline">{l.productTitle}</Link> : <span className="font-medium">{t("stock_takes.unknown_code")}</span>}<p className="text-xs font-normal text-muted-foreground">{l.variantTitle ? `${l.variantTitle} · ` : ""}{l.sku ?? l.code}</p></> },
                { key: "status", header: t("stock_takes.columns.status"), mobile: "badge", cell: (l) => <Badge variant={STATUS_BADGE[l.status]}>{t(`stock_takes.review.${l.status}`)}</Badge> },
                { key: "expected", header: t("stock_takes.columns.expected"), align: "right", className: "tabular", cell: (l) => (l.expected === null ? "—" : n(l.expected)) },
                { key: "counted", header: t("stock_takes.columns.counted"), align: "right", className: "tabular", mobile: canWrite ? "action" : "meta", cell: (l) => (canWrite ? <div className="flex items-center gap-2 md:block"><span className="mr-auto text-xs text-muted-foreground md:hidden">{t("stock_takes.columns.counted")}</span><CountEditor slug={tenant} stockTakeId={id} countId={l.id} counted={l.counted} /></div> : n(l.counted)) },
                { key: "difference", header: t("stock_takes.columns.difference"), align: "right", className: cn("tabular font-medium"), cell: (l) => <span className={cn(l.delta < 0 && "text-destructive", l.delta > 0 && "text-warning")}>{l.status === "unknown" ? "—" : `${l.delta > 0 ? "+" : ""}${n(l.delta)}`}</span> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(StockTakePage, "app/t/[tenant]/inventory/stock-takes/[id]/page.tsx");
