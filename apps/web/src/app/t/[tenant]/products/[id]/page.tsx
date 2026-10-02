import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canViewPage, canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, sanitizeProductHtml, shopifyAdminProductUrl } from "@hullwise/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, DataList, DetailShell, Skeleton, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { getProductDetail } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { ProductThumb } from "@/components/product-thumb";
import { latestPlatformWrites, priceHistory, productVersion } from "@hullwise/services";
import { AdjustStockDialog } from "@/components/adjust-stock-dialog";
import { SalesChart } from "@/components/charts/sales-chart";
import { ProductActions } from "./actions";
import { VariantCostsForm } from "./costs-form";
import { RecordTasks } from "@/components/record-tasks";
import { SupplierPacksSection } from "./supplier-section";
import { StockGrid } from "./stock-grid";
import { ProductGallery } from "./gallery";
import { ProductPnlCard } from "./pnl-card";
import { DetailsCard, EditInShopifyLink, OrganisationCard, ProductEditProvider, SeoCard, StatusCard, SyncProductButton, VariantsCard } from "./product-edit";

/**
 * Product page (issue #19), laid out like Shopify's: gallery, description, status and channels,
 * organisation, variants, SEO, metafields; every field mirrors the store, a defined subset is
 * edited here (platform first) and the rest links to the Shopify admin. Hullwise's own panels stay:
 * stock by location, velocity and cover, incoming POs, P/L, linked campaigns, the option grid,
 * price history, stock adjustment, costs and the default supplier.
 */
export default async function ProductDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "products");
  const detail = await getProductDetail(ctx, id);
  if (!detail) notFound();
  const { product, variants, stock, locations, daily, incomingPos, movements, campaigns, media, shopDomain } = detail;
  const t = await getTranslations("product_detail");
  const tm = await getTranslations("product_mirror");
  const tic = await getTranslations("inventory_control");
  const canAdjust = canWritePage(ctx.role, "inventory");
  const canEdit = canWritePage(ctx.role, "products");
  const fmt = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const totalAvailable = stock.reduce((s, r) => s + r.available, 0);
  const totalIncoming = stock.reduce((s, r) => s + r.incoming, 0);
  const totalSold = stock.reduce((s, r) => s + r.unitsSold, 0);
  const suggested = stock.reduce((s, r) => s + r.suggestedReorder, 0);
  const worst = stock.reduce<number | null>((w, r) => (r.daysOfCover === null ? w : w === null ? r.daysOfCover : Math.min(w, r.daysOfCover)), null);
  // sync state of the last price, status and stock writes sent to the platform
  const writes = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const ids = variants.map((v) => v.id);
    return { status: (await latestPlatformWrites(s, "product", [product.id], { kinds: ["product.status", "product.update"] })).get(product.id), price: await latestPlatformWrites(s, "variant", ids, { kinds: ["variant.update", "variant.prices", "variant.details"] }), stock: await latestPlatformWrites(s, "variant", ids, { kinds: ["inventory.set"] }), prices: await priceHistory(s, { variantIds: ids, limit: 10 }) };
  });
  const options = product.options as { name: string; values: string[] }[];
  const channels = (product.publishedChannels as { id: string; name: string; published: boolean }[] | null) ?? [];
  const collections = (product.collections as { id: string; title: string }[] | null) ?? [];
  const metafields = (product.metafields as { namespace: string; key: string; type: string; value: string }[] | null) ?? [];
  const mediaUrl = new Map(media.map((m) => [m.id, m.url]));
  const version = productVersion(product)?.toISOString() ?? null;
  const adminUrl = shopifyAdminProductUrl(shopDomain, product.externalId);
  const days: { day: string; units: number; revenue: number }[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const row = daily.find((x) => x.day === d);
    days.push({ day: d, units: row?.units ?? 0, revenue: row?.revenue ?? 0 });
  }
  const bool = (v: boolean | null) => (v === null ? "—" : v ? tm("yes") : tm("no"));
  return (
    <ProductEditProvider value={{ slug: tenant, productId: product.id, version, canEdit }}>
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
            <Badge variant={product.status === "active" ? "success" : "muted"}>{(await getTranslations("products"))(`status.${product.status}`)}</Badge>
            <PlatformWriteStatus slug={tenant} write={writes.status} canRetry={canEdit} />
            {!product.isRepurchasable && <Badge variant="outline">{t("not_repurchasable")}</Badge>}
            {options.map((o) => (
              <Badge key={o.name} variant="secondary">
                {o.name}: {o.values.join(", ")}
              </Badge>
            ))}
            <span className="text-xs text-muted-foreground" data-testid="product-last-synced">{product.syncedAt ? tm("last_synced", { when: formatDateTime(product.syncedAt, ctx.locale, ctx.tenant.timezone) }) : tm("never_synced")}</span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {canEdit && product.externalId && <SyncProductButton />}
            <EditInShopifyLink href={adminUrl} />
            {canAdjust && variants.length > 0 && <AdjustStockDialog slug={tenant} variants={variants.map((v) => ({ id: v.id, label: `${v.title}${v.sku ? ` · ${v.sku}` : ""}`, levels: Object.fromEntries((stock.find((r) => r.variantId === v.id)?.byLocation ?? []).map((l) => [l.locationId, l.available])) }))} locations={locations.map((l) => ({ id: l.id, name: l.name }))} />}
            {canEdit && <ProductActions slug={tenant} productId={product.id} isRepurchasable={product.isRepurchasable} />}
          </div>
        }
        aside={
          <>
            <StatusCard status={product.status} channels={channels} />
            <OrganisationCard vendor={product.vendor} productType={product.productType} categoryId={product.categoryId} categoryName={product.categoryName} collections={collections} tags={product.tags} />
            <RecordTasks slug={tenant} type="product" id={product.id} label={product.title} />
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
                    <span>{t(`movement.${m.reason}`)}{m.reasonCode ? ` · ${tic(`reasons.${m.reasonCode}`)}` : ""}</span>
                    <span className={`tabular ${m.delta > 0 ? "text-success" : "text-destructive"}`}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card data-testid="price-history">
              <CardHeader>
                <CardTitle className="text-base">{tic("price_history.title")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                {writes.prices.length === 0 && <p className="text-muted-foreground">{tic("price_history.empty")}</p>}
                {writes.prices.map((h) => (
                  <div key={h.c.id} className="flex flex-wrap justify-between gap-x-2">
                    <span className="text-muted-foreground">{formatDate(h.c.createdAt, ctx.locale, ctx.tenant.timezone)} · {h.variantTitle}</span>
                    <span className="tabular">{fmt(h.c.priceBeforeMinor)} → {fmt(h.c.priceAfterMinor)}{h.c.compareAtAfterMinor !== null && h.c.compareAtAfterMinor !== h.c.compareAtBeforeMinor ? ` (${fmt(h.c.compareAtAfterMinor)})` : ""} <span className="text-muted-foreground">{tic(`price_history.source.${h.c.source}`)}</span></span>
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
        <div className="grid gap-6 xl:grid-cols-2 [&>*]:min-w-0">
          <ProductGallery slug={tenant} productId={product.id} version={version} media={media.map((m) => ({ id: m.id, type: m.type, url: m.url, alt: m.alt }))} title={product.title} canEdit={canEdit} />
          <DetailsCard title={product.title} descriptionHtml={product.descriptionHtml} safeDescription={sanitizeProductHtml(product.descriptionHtml)} />
        </div>
        <VariantsCard
          title={t("variants")}
          rows={variants.filter((v) => v.isActive).map((v) => ({ id: v.id, title: v.title, price: (v.priceMinor / 100).toFixed(2), compareAt: v.compareAtMinor !== null ? (v.compareAtMinor / 100).toFixed(2) : "", sku: v.sku ?? "", barcode: v.barcode ?? "", weight: v.weightGrams !== null ? String(v.weightGrams) : "", inventoryPolicy: v.inventoryPolicy ?? "deny" }))}
        >
          <DataList
            rows={variants.map((v) => ({ v, s: stock.find((r) => r.variantId === v.id) }))}
            rowKey={({ v }) => v.id}
            rowProps={() => ({ "data-testid": "variant-row" })}
            columns={[
              {
                key: "title",
                header: t("variant.title"),
                mobile: "title",
                cell: ({ v }) => (
                  <div className="flex items-center gap-2">
                    <ProductThumb src={(v.imageMediaId && mediaUrl.get(v.imageMediaId)) || product.imageUrl} alt={v.title} size="xs" />
                    <div className="min-w-0">
                      <div className="font-medium">{canViewPage(ctx.role, "orders") ? <Link href={`/t/${tenant}/orders?variant=${v.id}`} className="hover:underline" title={t("view_orders")}>{v.title}</Link> : v.title}{!v.isActive && <Badge variant="outline" className="ml-1">{tm("variants.inactive")}</Badge>}</div>
                      <div className="text-xs font-normal text-muted-foreground">{v.sku}</div>
                    </div>
                  </div>
                ),
              },
              { key: "price", header: t("variant.price"), align: "right", className: "tabular", cell: ({ v }) => <>{fmt(v.priceMinor)}{v.compareAtMinor !== null && <div className="text-xs text-muted-foreground line-through max-md:ml-1 max-md:inline">{fmt(v.compareAtMinor)}</div>}<PlatformWriteStatus slug={tenant} write={writes.price.get(v.id)} canRetry={canEdit} className="justify-end" /></> },
              { key: "cost", header: t("variant.cost"), align: "right", className: "tabular text-muted-foreground", cell: ({ v }) => (v.costMinor !== null ? fmt(v.costMinor) : "—") },
              ...locations.map((l) => ({ key: `loc-${l.id}`, header: l.name, priority: 2 as const, align: "right" as const, className: "tabular", cell: ({ s }: { s: (typeof stock)[number] | undefined }) => s?.byLocation.find((x) => x.locationId === l.id)?.available ?? 0 })),
              { key: "available", header: t("variant.available"), mobile: "badge", align: "right", className: "tabular font-medium", cell: ({ v, s }) => <>{s?.available ?? 0}<PlatformWriteStatus slug={tenant} write={writes.stock.get(v.id)} canRetry={canEdit} className="justify-end" /></> },
              { key: "incoming", header: t("variant.incoming"), align: "right", className: "tabular text-muted-foreground", cell: ({ s }) => (s?.incoming ? `+${s.incoming}` : "—") },
              { key: "velocity", header: t("variant.velocity"), align: "right", className: "tabular", cell: ({ s }) => (s ? s.velocityPerDay.toFixed(2) : "—") },
              { key: "risk", header: t("variant.risk"), label: "", cell: ({ s }) => s && <RiskBadge risk={s.risk} days={s.daysOfCover} /> },
              { key: "reorder", header: t("variant.reorder"), align: "right", className: "tabular", cell: ({ s }) => (s?.suggestedReorder ? s.suggestedReorder : "—") },
            ]}
          />
          <details className="border-t px-4 py-3 text-sm" data-testid="variant-fields">
            <summary className="cursor-pointer text-muted-foreground">{tm("variants.more_fields")}</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[44rem] text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr><th className="p-1">{t("variant.title")}</th><th className="p-1">{tm("variants.barcode")}</th><th className="p-1 text-right">{tm("variants.weight")}</th><th className="p-1">{tm("variants.policy")}</th><th className="p-1">{tm("variants.tracked")}</th><th className="p-1">{tm("variants.requires_shipping")}</th><th className="p-1">{tm("variants.taxable")}</th><th className="p-1">{tm("variants.hs_code")}</th><th className="p-1">{tm("variants.origin")}</th></tr>
                </thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id} className="border-t">
                      <td className="p-1 font-medium">{v.title}</td>
                      <td className="p-1 font-mono">{v.barcode ?? "—"}</td>
                      <td className="p-1 text-right tabular">{v.weightGrams !== null ? `${formatNumber(v.weightGrams, ctx.locale)} g` : "—"}</td>
                      <td className="p-1">{v.inventoryPolicy ? tm(`variants.policy_${v.inventoryPolicy}`) : "—"}</td>
                      <td className="p-1">{bool(v.tracksInventory)}</td>
                      <td className="p-1">{bool(v.requiresShipping)}</td>
                      <td className="p-1">{bool(v.taxable)}</td>
                      <td className="p-1 font-mono">{v.hsCode ?? "—"}</td>
                      <td className="p-1">{v.countryOfOrigin ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </VariantsCard>
        <StockGrid options={options} locale={ctx.locale} variants={variants.map((v) => { const s = stock.find((r) => r.variantId === v.id); return { id: v.id, optionValues: (v.optionValues ?? {}) as Record<string, string>, available: s?.available ?? 0, incoming: s?.incoming ?? 0, committed: s?.committed ?? 0 }; })} />
        <div className="grid gap-6 xl:grid-cols-2 [&>*]:min-w-0">
          <SeoCard title={product.title} handle={product.handle} seoTitle={product.seoTitle} seoDescription={product.seoDescription} descriptionHtml={product.descriptionHtml} storeHost={shopDomain} />
          <Card data-testid="product-metafields">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">{tm("metafields.title")}</CardTitle>
              <span className="text-xs text-muted-foreground">{tm("metafields.read_only")}</span>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {metafields.length === 0 && <p className="text-muted-foreground">{tm("metafields.empty")}</p>}
              {metafields.map((m) => (
                <div key={`${m.namespace}.${m.key}`} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2">
                  <span className="truncate font-mono text-muted-foreground" title={`${m.namespace}.${m.key} · ${m.type}`}>{m.namespace}.{m.key}</span>
                  <span className="whitespace-pre-line break-words">{m.value.length > 400 ? `${m.value.slice(0, 400)}…` : m.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[2fr_1fr] [&>*]:min-w-0">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">{t("sales_90d")}</CardTitle>
              {canViewPage(ctx.role, "orders") && <Link href={`/t/${tenant}/orders?product=${product.id}`} className="text-sm text-primary hover:underline" data-testid="product-orders-link">{t("view_orders")}</Link>}
            </CardHeader>
            <CardContent>
              <SalesChart data={days} locale={ctx.locale} currency={ctx.tenant.currency} />
            </CardContent>
          </Card>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <ProductPnlCard ctx={ctx} slug={tenant} productId={product.id} title={product.title} />
          </Suspense>
        </div>
        <VariantCostsForm slug={tenant} productId={product.id} canEdit={canEdit} writeBack={ctx.settings.costWriteBack} variants={variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, cost: v.costMinor !== null ? (v.costMinor / 100).toFixed(2) : "", source: v.costSource, updated: v.costUpdatedAt ? formatDate(v.costUpdatedAt, ctx.locale, ctx.tenant.timezone) : null }))} />
        <SupplierPacksSection ctx={ctx} slug={tenant} productId={product.id} />
      </DetailShell>
    </ProductEditProvider>
  );
}
