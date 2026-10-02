import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@hullwise/config";
import { formatMoney } from "@hullwise/core";
import { Card, CardContent, DataList, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { listSuppliers } from "@/server/queries/purchasing";
import { bulkSupplierFacets } from "@hullwise/services";
import { SupplierForm } from "./form";
import { BulkSupplierCard } from "./bulk";

export default async function SuppliersPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { tenant } = await params;
  const { edit } = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("suppliers");
  const suppliers = await listSuppliers(ctx);
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  const editing = canWrite && edit ? suppliers.find((s) => s.id === edit) : undefined;
  const facets = canWrite ? await ctx.run((tx) => bulkSupplierFacets({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } })) : null;
  return (
    <>
      <Link href={`/t/${tenant}/purchasing`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={suppliers}
              rowKey={(s) => s.id}
              rowProps={(s) => ({ "data-testid": "supplier-row", "data-supplier": s.id })}
              columns={[
                { key: "supplier", header: t("columns.supplier"), mobile: "title", cell: (s) => <><Link href={`/t/${tenant}/purchasing?supplier=${s.id}`} className="font-medium text-primary hover:underline">{s.name}</Link><p className="text-xs font-normal text-muted-foreground">{s.contactName ? `${s.contactName} · ` : ""}{s.payeeName} · {s.country}</p></> },
                { key: "balance", header: t("columns.balance"), mobile: "badge", align: "right", className: `tabular font-medium`, cell: (s) => <span className={s.balance.balanceMinor > 0 ? "text-warning" : ""}>{formatMoney(s.balance.balanceMinor, ctx.tenant.currency, ctx.locale)}</span> },
                { key: "contact", header: t("columns.contact"), mobile: "subtitle", className: "text-sm text-muted-foreground", cell: (s) => <>{s.email && <a href={`mailto:${s.email}`} className="break-all hover:underline">{s.email}</a>}{s.email && s.phone && <br className="max-md:hidden" />}{s.email && s.phone && <span className="md:hidden"> · </span>}{s.phone && <a href={`tel:${s.phone}`} className="hover:underline">{s.phone}</a>}</> },
                { key: "lead", header: t("columns.lead_time"), align: "right", className: "tabular", cell: (s) => <>{s.leadTimeDays ?? "—"}{s.leadTimeSdDays ? <span className="text-xs text-muted-foreground"> ±{s.leadTimeSdDays}</span> : null}</> },
                { key: "terms", header: t("columns.terms"), label: "", priority: 2, className: "text-xs text-muted-foreground", cell: (s) => <>{t("terms_summary", { deposit: s.depositBps / 100, days: s.balanceDays })}{s.moqDefault ? <><br className="max-md:hidden" /><span className="md:hidden"> · </span>{t("moq_summary", { moq: s.moqDefault })}</> : null}</> },
                { key: "owed", header: t("columns.owed"), align: "right", className: "tabular", cell: (s) => formatMoney(s.balance.owedMinor, ctx.tenant.currency, ctx.locale) },
                { key: "paid", header: t("columns.paid"), align: "right", className: "tabular", cell: (s) => formatMoney(s.balance.paidMinor, ctx.tenant.currency, ctx.locale) },
                ...(canWrite ? [{ key: "edit", header: <span className="sr-only">{t("edit")}</span>, mobile: "action" as const, align: "right" as const, cell: (s: (typeof suppliers)[number]) => <Link href={`/t/${tenant}/purchasing/suppliers?edit=${s.id}#supplier-form`} className="text-sm text-primary hover:underline max-md:inline-flex max-md:min-h-9 max-md:items-center" data-testid={`edit-supplier-${s.id}`}>{t("edit")}</Link> }] : []),
              ]}
            />
          </CardContent>
        </Card>
        {canWrite && <div id="supplier-form" className={editing ? "max-lg:order-first" : undefined}><SupplierForm slug={tenant} supplier={editing} cancelHref={editing ? `/t/${tenant}/purchasing/suppliers` : undefined} /></div>}
      </div>
      {facets && <div className="mt-6"><BulkSupplierCard slug={tenant} suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))} productTypes={facets.productTypes} vendors={facets.vendors} withoutSupplier={facets.variantsWithoutSupplier} /></div>}
    </>
  );
}
