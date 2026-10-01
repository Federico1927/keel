import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@keel/config";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { getProductDetail } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { latestPlatformWrites } from "@keel/services";
import { SalesChart } from "@/components/charts/sales-chart";
import { ProductActions, VariantPriceForm } from "./actions";

export default async function ProductDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "products");
  const detail = await getProductDetail(ctx, id);
  if (!detail) notFound();
  const { product, variants, stock, locations, daily, incomingPos, movements, campaigns } = detail;
  const t = await getTranslations("product_detail");
  const tp = await getTranslations("products");
  const fmt = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const totalAvailable = stock.reduce((s, r) => s + r.available, 0);
  const totalIncoming = stock.reduce((s, r) => s + r.incoming, 0);
  const totalSold = stock.reduce((s, r) => s + r.unitsSold, 0);
  const suggested = stock.reduce((s, r) => s + r.suggestedReorder, 0);
  const worst = stock.reduce<number | null>((w, r) => (r.daysOfCover === null ? w : w === null ? r.daysOfCover : Math.min(w, r.daysOfCover)), null);
  const canEdit = canDo(ctx.role, "edit") && (ctx.role === "owner" || ctx.role === "admin" || ctx.role === "operations");
  // sync state of the last price, status and stock writes sent to the platform
  const writes = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const ids = variants.map((v) => v.id);
    return { status: (await latestPlatformWrites(s, "product", [product.id], { kinds: ["product.status"] })).get(product.id), price: await latestPlatformWrites(s, "variant", ids, { kinds: ["variant.update"] }), stock: await latestPlatformWrites(s, "variant", ids, { kinds: ["inventory.set"] }) };
  });
  const options = product.options as { name: string; values: string[] }[];
  const days: { day: string; units: number; revenue: number }[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const row = daily.find((x) => x.day === d);
    days.push({ day: d, units: row?.units ?? 0, revenue: row?.revenue ?? 0 });
  }
  return (
    <DetailShell
      back={
        <Link href={`/t/${tenant}/products`} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t("back")}
        </Link>
      }
      eyebrow={[product.vendor, product.productType].filter(Boolean).join(" · ")}
      title={product.title}
      chips={
        <>
          <Badge variant={product.status === "active" ? "success" : "muted"}>{tp(`status.${product.status}`)}</Badge>
          <PlatformWriteStatus slug={tenant} write={writes.status} canRetry={canEdit} />
          {!product.isRepurchasable && <Badge variant="outline">{t("not_repurchasable")}</Badge>}
          {options.map((o) => (
            <Badge key={o.name} variant="secondary">
              {o.name}: {o.values.join(", ")}
            </Badge>
          ))}
        </>
      }
      actions={canEdit ? <ProductActions slug={tenant} productId={product.id} status={product.status} isRepurchasable={product.isRepurchasable} /> : undefined}
      aside={
        <>
          {incomingPos.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("incoming")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {incomingPos.map((po, i) => (
                  <Link key={`${po.poId}-${i}`} href={`/t/${tenant}/purchasing/${po.poId}`} className="flex items-center justify-between rounded border p-2 hover:bg-muted/40">
                    <span>
                      {po.number} <span className="text-muted-foreground">· {variants.find((v) => v.id === po.variantId)?.title}</span>
                    </span>
                    <span className="tabular">+{po.quantity}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {campaigns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("campaigns")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {campaigns.map((c) => (
                  <Link key={c.id} href={`/t/${tenant}/campaigns/${c.id}`} className="block truncate text-primary hover:underline">
                    {c.platform} · {c.name}
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("movements")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              {movements.length === 0 && <p className="text-muted-foreground">{t("no_movements")}</p>}
              {movements.slice(0, 12).map((m) => (
                <div key={m.id} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{formatDateTime(m.createdAt, ctx.locale, ctx.tenant.timezone)}</span>
                  <span>{t(`movement.${m.reason}`)}</span>
                  <span className={`tabular ${m.delta > 0 ? "text-success" : "text-destructive"}`}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("kpi.available")} value={formatNumber(totalAvailable, ctx.locale)} />
        <Stat label={t("kpi.incoming")} value={formatNumber(totalIncoming, ctx.locale)} />
        <Stat label={t("kpi.sold", { days: ctx.settings.salesVelocityLookbackDays })} value={formatNumber(totalSold, ctx.locale)} />
        <Stat label={t("kpi.cover")} value={worst === null ? "—" : `${Math.round(worst)}d`} />
        <Stat label={t("kpi.reorder")} value={suggested > 0 ? formatNumber(suggested, ctx.locale) : "—"} hint={suggested > 0 ? <Link href={`/t/${tenant}/purchasing/new?product=${product.id}`} className="text-primary underline">{t("create_po")}</Link> : undefined} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("sales_90d")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SalesChart data={days} locale={ctx.locale} currency={ctx.tenant.currency} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("variants")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("variant.title")}</TableHead>
                <TableHead>{t("variant.sku")}</TableHead>
                <TableHead className="text-right">{t("variant.price")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("variant.cost")}</TableHead>
                {locations.map((l) => (
                  <TableHead key={l.id} className="hidden text-right lg:table-cell">{l.name}</TableHead>
                ))}
                <TableHead className="text-right">{t("variant.available")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("variant.incoming")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("variant.velocity")}</TableHead>
                <TableHead>{t("variant.risk")}</TableHead>
                <TableHead className="text-right">{t("variant.reorder")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => {
                const s = stock.find((r) => r.variantId === v.id);
                return (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">{v.title}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{v.sku}</TableCell>
                    <TableCell className="text-right tabular">{canEdit ? <VariantPriceForm slug={tenant} variantId={v.id} price={v.priceMinor / 100} /> : fmt(v.priceMinor)}<PlatformWriteStatus slug={tenant} write={writes.price.get(v.id)} canRetry={canEdit} className="justify-end" /></TableCell>
                    <TableCell className="hidden text-right tabular text-muted-foreground md:table-cell">{v.costMinor !== null ? fmt(v.costMinor) : "—"}</TableCell>
                    {locations.map((l) => (
                      <TableCell key={l.id} className="hidden text-right tabular lg:table-cell">{s?.byLocation.find((x) => x.locationId === l.id)?.available ?? 0}</TableCell>
                    ))}
                    <TableCell className="text-right tabular font-medium">{s?.available ?? 0}<PlatformWriteStatus slug={tenant} write={writes.stock.get(v.id)} canRetry={canEdit} className="justify-end" /></TableCell>
                    <TableCell className="hidden text-right tabular text-muted-foreground md:table-cell">{s?.incoming ? `+${s.incoming}` : "—"}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{s ? s.velocityPerDay.toFixed(2) : "—"}</TableCell>
                    <TableCell>{s && <RiskBadge risk={s.risk} days={s.daysOfCover} />}</TableCell>
                    <TableCell className="text-right tabular">{s?.suggestedReorder ? s.suggestedReorder : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </DetailShell>
  );
}
