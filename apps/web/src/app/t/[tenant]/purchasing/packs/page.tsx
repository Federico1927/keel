import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@hullwise/config";
import { asc, eq, schema } from "@hullwise/db";
import { listCasePacks } from "@hullwise/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CasePackForm, DeletePackButton } from "./form";

/** Tenant-defined case packs: units per value of one option (any option name), for all products or one. */
export default async function CasePacksPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("case_packs");
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  const [packs, products] = await Promise.all([
    ctx.run((tx) => listCasePacks({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } })),
    ctx.run((tx) => tx.select({ id: schema.products.id, title: schema.products.title, options: schema.products.options }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenant.id)).orderBy(asc(schema.products.title))),
  ]);
  // option names and their values across the catalogue (case-insensitive name)
  const options = new Map<string, { name: string; values: Set<string> }>();
  for (const p of products) for (const o of p.options as { name: string; values: string[] }[]) {
    const cur = options.get(o.name.toLowerCase()) ?? { name: o.name, values: new Set<string>() };
    for (const v of o.values) cur.values.add(v);
    options.set(o.name.toLowerCase(), cur);
  }
  const optionList = [...options.values()].map((o) => ({ name: o.name, values: [...o.values] })).sort((a, b) => a.name.localeCompare(b.name));
  const productList = products.map((p) => ({ id: p.id, title: p.title, options: (p.options as { name: string }[]).map((o) => o.name.toLowerCase()) }));
  return (
    <>
      <Link href={`/t/${tenant}/purchasing`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <h1 className="mb-1 text-2xl sm:text-3xl">{t("title")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t("description")}</p>
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="space-y-3">
          {packs.length === 0 && <EmptyState title={t("empty_title")} description={t("empty_description")} />}
          {packs.map((p) => (
            <Card key={p.id} data-testid="case-pack">
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">{p.productTitle ? t("for_product", { product: p.productTitle }) : t("for_all", { option: p.optionName })}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!p.isActive && <Badge variant="muted">{t("inactive")}</Badge>}
                  <Badge variant="secondary">{t("units_per_pack", { n: p.totalUnits })}</Badge>
                  {canWrite && <DeletePackButton slug={tenant} id={p.id} />}
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2 text-sm">
                <span className="text-muted-foreground">{p.optionName}:</span>
                {Object.entries(p.units).map(([v, n]) => (
                  <span key={v} className="rounded border px-2 py-0.5 tabular">{v} × {n}</span>
                ))}
              </CardContent>
              {canWrite && (
                <CardContent className="border-t pt-4">
                  <CasePackForm slug={tenant} options={optionList} products={productList} pack={{ id: p.id, name: p.name, optionName: p.optionName, productId: p.productId, units: p.units, isActive: p.isActive }} />
                </CardContent>
              )}
            </Card>
          ))}
        </div>
        {canWrite && (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-base">{t("add_title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {optionList.length === 0 ? <p className="text-sm text-muted-foreground">{t("no_options")}</p> : <CasePackForm slug={tenant} options={optionList} products={productList} />}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
