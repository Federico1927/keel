import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDate, formatMoney } from "@keel/core";
import { listInvoices } from "@keel/services";
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingRunButton } from "./controls";
import { InvoiceActions } from "../tenants/[id]/controls";

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { db } = await requireSuperAdmin();
  const { status } = await searchParams;
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const rows = await listInvoices(db, { status: ["open", "paid", "void"].includes(status ?? "") ? status : undefined });
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("billing.title")} description={t("billing.description")} actions={<BillingRunButton />} />
      <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {["all", "open", "paid", "void"].map((s) => (
          <Link key={s} href={s === "all" ? "/admin/billing" : `/admin/billing?status=${s}`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", (status ?? "all") === s ? "bg-card shadow-sm" : "text-muted-foreground")}>{s === "all" ? t("billing.all") : t(`billing.status.${s}`)}</Link>
        ))}
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.columns.number")}</TableHead>
                <TableHead>{t("tenants.columns.tenant")}</TableHead>
                <TableHead>{t("billing.columns.kind")}</TableHead>
                <TableHead className="text-right">{t("billing.columns.amount")}</TableHead>
                <TableHead>{t("billing.columns.issued")}</TableHead>
                <TableHead>{t("billing.columns.due")}</TableHead>
                <TableHead>{t("billing.columns.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ invoice: i, tenantName, tenantSlug }) => (
                <TableRow key={i.id} data-testid="invoice-row">
                  <TableCell className="font-mono text-xs">{i.number}</TableCell>
                  <TableCell><Link href={`/admin/tenants/${i.tenantId}`} className="hover:underline">{tenantName}</Link><div className="text-xs text-muted-foreground">{tenantSlug}</div></TableCell>
                  <TableCell>{t(`billing.kind.${i.kind}`)}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(i.amountMinor, i.currency, locale)}</TableCell>
                  <TableCell>{formatDate(i.issuedAt, locale, "UTC")}</TableCell>
                  <TableCell>{formatDate(i.dueAt, locale, "UTC")}</TableCell>
                  <TableCell><Badge variant={i.status === "paid" ? "success" : i.status === "open" ? (i.dueAt < new Date() ? "destructive" : "warning") : "muted"}>{t(`billing.status.${i.status}`)}</Badge></TableCell>
                  <TableCell><InvoiceActions invoiceId={i.id} status={i.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
