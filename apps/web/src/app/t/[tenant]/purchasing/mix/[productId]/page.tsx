import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@hullwise/config";
import { formatNumber, formatPercent, optionMixShares } from "@hullwise/core";
import { asc, eq, schema } from "@hullwise/db";
import { optionMix } from "@hullwise/services";
import { Card, CardContent, CardHeader, CardTitle, DataList, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { MixPlanner } from "./planner";

import { withIntl } from "@/i18n/intl-scope";
const WINDOWS = [90, 180, 365] as const;

/**
 * Option mix of a product: sales share per option combination over a window, the share of each
 * option value, and a planner that turns a total (split by share) or N case packs per option group
 * into a draft purchase order.
 */
async function OptionMixPage({ params, searchParams }: { params: Promise<{ tenant: string; productId: string }>; searchParams: Promise<{ days?: string }> }) {
  const { tenant, productId } = await params;
  const { days } = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const lookback = WINDOWS.find((w) => String(w) === days) ?? 180;
  const t = await getTranslations("option_mix");
  const svc = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const [mix, suppliers, locations] = await Promise.all([
    ctx.run((tx) => optionMix(svc(tx), { id: ctx.tenant.id, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, settings: ctx.settings }, productId, lookback)),
    ctx.run((tx) => tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(asc(schema.suppliers.name))),
    ctx.run((tx) => tx.select({ id: schema.locations.id, name: schema.locations.name, isDefault: schema.locations.isDefault }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id))),
  ]);
  if (!mix) notFound();
  const optionNames = mix.product.options.map((o) => o.name);
  const totalSold = mix.variants.reduce((s, v) => s + v.unitsSold, 0);
  // the most common default supplier of the product's variants
  const counts = new Map<string, number>();
  for (const v of mix.variants) if (v.supplierId) counts.set(v.supplierId, (counts.get(v.supplierId) ?? 0) + 1);
  const defaultSupplier = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? suppliers[0]?.id ?? "";
  return (
    <>
      <Link href={`/t/${tenant}/products/${productId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {mix.product.title}
      </Link>
      <h1 className="mb-1 text-2xl sm:text-3xl">{t("title", { product: mix.product.title })}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t("description")}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("window")}</span>
        {WINDOWS.map((w) => (
          <Link key={w} href={`?days=${w}`} className={cn("rounded-full border px-3 py-1 text-xs", w === lookback ? "bg-primary text-primary-foreground" : "bg-card")}>{t("days", { n: w })}</Link>
        ))}
        <span className="ml-auto text-muted-foreground">{t("units_sold", { n: formatNumber(totalSold, ctx.locale) })}</span>
      </div>
      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {optionNames.map((name) => (
          <Card key={name}>
            <CardHeader>
              <CardTitle className="text-sm">{t("share_by", { option: name })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {optionMixShares(mix.variants.map((v) => ({ optionValues: v.optionValues, units: v.unitsSold })), [name]).map((r) => (
                <div key={r.key} className="flex items-center gap-2">
                  <span className="w-24 truncate">{Object.values(r.values)[0] ?? "—"}</span>
                  <div className="h-2 flex-1 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${Math.round(r.share * 100)}%` }} /></div>
                  <span className="w-14 text-right tabular">{formatPercent(r.share, ctx.locale, 0)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t("combinations")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={mix.variants}
            rowKey={(v) => v.variantId}
            rowProps={() => ({ "data-testid": "mix-row" })}
            columns={[
              ...optionNames.map((n, i) => ({ key: `opt-${i}`, header: n, label: n, mobile: i === 0 ? ("title" as const) : ("meta" as const), cell: (v: (typeof mix.variants)[number]) => v.optionValues[n] ?? "—" })),
              ...(optionNames.length === 0 ? [{ key: "variant", header: t("sku"), mobile: "title" as const, cell: (v: (typeof mix.variants)[number]) => v.title }] : []),
              { key: "sku", header: t("sku"), className: "text-xs text-muted-foreground", cell: (v) => v.sku },
              { key: "sold", header: t("sold"), align: "right", className: "tabular", cell: (v) => v.unitsSold },
              { key: "share", header: t("share"), align: "right", className: "tabular", cell: (v) => formatPercent(v.share, ctx.locale, 1) },
              { key: "suggested", header: t("suggested"), mobile: "badge", align: "right", className: "tabular", cell: (v) => v.suggested || "—" },
            ]}
          />
        </CardContent>
      </Card>
      {canDo(ctx.role, "receive_purchase_order") && suppliers.length > 0 && (
        <MixPlanner
          slug={tenant}
          productId={productId}
          lookbackDays={lookback}
          currency={ctx.tenant.currency}
          variants={mix.variants.map((v) => ({ id: v.variantId, title: v.title, sku: v.sku, optionValues: v.optionValues, share: v.share, suggested: v.suggested, costMinor: v.costMinor }))}
          packs={mix.packs.map((p) => ({ id: p.id, name: p.name, optionName: p.optionName, units: p.units, totalUnits: p.totalUnits }))}
          suggestions={Object.fromEntries(mix.suggestions.map((s) => [s.packId, Object.fromEntries(s.groups.map((g) => [g.key, g.packs]))]))}
          suppliers={suppliers}
          defaultSupplierId={defaultSupplier}
          locations={locations}
        />
      )}
    </>
  );
}

export default withIntl(OptionMixPage, "app/t/[tenant]/purchasing/mix/[productId]/page.tsx");
