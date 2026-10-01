import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@keel/config";
import { formatMoney } from "@keel/core";
import { Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { listSuppliers } from "@/server/queries/purchasing";
import { SupplierForm } from "./form";

export default async function SuppliersPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { tenant } = await params;
  const { edit } = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("suppliers");
  const suppliers = await listSuppliers(ctx);
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  const editing = canWrite && edit ? suppliers.find((s) => s.id === edit) : undefined;
  return (
    <>
      <Link href={`/t/${tenant}/purchasing`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.supplier")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.contact")}</TableHead>
                  <TableHead className="text-right">{t("columns.lead_time")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.terms")}</TableHead>
                  <TableHead className="text-right">{t("columns.owed")}</TableHead>
                  <TableHead className="text-right">{t("columns.paid")}</TableHead>
                  <TableHead className="text-right">{t("columns.balance")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link href={`/t/${tenant}/purchasing?supplier=${s.id}`} className="font-medium text-primary hover:underline">{s.name}</Link>
                      <p className="text-xs text-muted-foreground">{s.contactName ? `${s.contactName} · ` : ""}{s.payeeName} · {s.country}</p>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{s.email}<br />{s.phone}</TableCell>
                    <TableCell className="text-right tabular">{s.leadTimeDays ?? "—"}{s.leadTimeSdDays ? <span className="text-xs text-muted-foreground"> ±{s.leadTimeSdDays}</span> : null}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {t("terms_summary", { deposit: s.depositBps / 100, days: s.balanceDays })}
                      {s.moqDefault ? <><br />{t("moq_summary", { moq: s.moqDefault })}</> : null}
                      {canWrite && <><br /><Link href={`/t/${tenant}/purchasing/suppliers?edit=${s.id}`} className="text-primary hover:underline" data-testid={`edit-supplier-${s.id}`}>{t("edit")}</Link></>}
                    </TableCell>
                    <TableCell className="text-right tabular">{formatMoney(s.balance.owedMinor, ctx.tenant.currency, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(s.balance.paidMinor, ctx.tenant.currency, ctx.locale)}</TableCell>
                    <TableCell className={`text-right tabular font-medium ${s.balance.balanceMinor > 0 ? "text-warning" : ""}`}>{formatMoney(s.balance.balanceMinor, ctx.tenant.currency, ctx.locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {canWrite && <SupplierForm slug={tenant} supplier={editing} cancelHref={editing ? `/t/${tenant}/purchasing/suppliers` : undefined} />}
      </div>
    </>
  );
}
