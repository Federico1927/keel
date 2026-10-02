import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@keel/config";
import { formatDateTime, formatNumber } from "@keel/core";
import { InventoryControlError, stockTakeDetail } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { svcOf } from "@/server/queries/inventory-control";
import { CountEditor, StockTakeActions, StockTakeScanner } from "../controls";

const STATUS_BADGE = { match: "success", missing: "destructive", surplus: "warning", unknown: "muted" } as const;

export default async function StockTakePage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("stock_takes.columns.variant")}</TableHead>
                  <TableHead>{t("stock_takes.columns.status")}</TableHead>
                  <TableHead className="text-right">{t("stock_takes.columns.expected")}</TableHead>
                  <TableHead className="text-right">{t("stock_takes.columns.counted")}</TableHead>
                  <TableHead className="text-right">{t("stock_takes.columns.difference")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((l) => (
                  <TableRow key={l.id} data-testid="stock-take-line" data-status={l.status}>
                    <TableCell>
                      {l.productId ? <Link href={`/t/${tenant}/products/${l.productId}`} className="font-medium text-primary hover:underline">{l.productTitle}</Link> : <span className="font-medium">{t("stock_takes.unknown_code")}</span>}
                      <p className="text-xs text-muted-foreground">{l.variantTitle ? `${l.variantTitle} · ` : ""}{l.sku ?? l.code}</p>
                    </TableCell>
                    <TableCell><Badge variant={STATUS_BADGE[l.status]}>{t(`stock_takes.review.${l.status}`)}</Badge></TableCell>
                    <TableCell className="text-right tabular">{l.expected === null ? "—" : n(l.expected)}</TableCell>
                    <TableCell className="text-right tabular">{canWrite ? <CountEditor slug={tenant} stockTakeId={id} countId={l.id} counted={l.counted} /> : n(l.counted)}</TableCell>
                    <TableCell className={cn("text-right tabular font-medium", l.delta < 0 && "text-destructive", l.delta > 0 && "text-warning")}>{l.status === "unknown" ? "—" : `${l.delta > 0 ? "+" : ""}${n(l.delta)}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
