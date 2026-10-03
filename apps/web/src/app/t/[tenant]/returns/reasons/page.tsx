import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SUPPORTED_LOCALES, canWritePage } from "@hullwise/config";
import { SHOPIFY_RETURN_REASONS } from "@hullwise/integrations";
import { listReturnReasons } from "@hullwise/services";
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { ReasonForm, ReasonToggle } from "./reason-form";

import { withIntl } from "@/i18n/intl-scope";
async function ReturnReasonsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { tenant } = await params;
  const { edit } = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  if (!canWritePage(ctx.role, "returns")) notFound();
  const t = await getTranslations("return_reasons");
  const tr = await getTranslations("returns");
  const td = await getTranslations("return_detail");
  const reasons = await ctx.run((tx) => listReturnReasons({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/returns`} className="hover:underline">← {tr("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { window: ctx.settings.returnWindowDays, excluded: ctx.settings.returnExcludedProductTypes.length })} />
      <div className="space-y-6">
        <ReasonForm slug={tenant} reason={reasons.find((r) => r.code === edit)} locales={[...SUPPORTED_LOCALES]} platformReasons={SHOPIFY_RETURN_REASONS} />
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("code")}</TableHead>
                  <TableHead>{t("label")}</TableHead>
                  <TableHead>{t("default_fault")}</TableHead>
                  <TableHead className="text-right">{t("active")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reasons.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><Link href={`/t/${tenant}/returns/reasons?edit=${r.code}`} className="hover:underline"><code className="text-xs">{r.code}</code></Link>{r.platformReason && <span className="ml-2 text-xs text-muted-foreground">{r.platformReason}</span>}</TableCell>
                    <TableCell>{r.label}</TableCell>
                    <TableCell><Badge variant={r.defaultFault === "merchant" ? "warning" : "muted"}>{td(`faults.${r.defaultFault}`)}</Badge></TableCell>
                    <TableCell className="text-right"><ReasonToggle slug={tenant} reasonId={r.id} isActive={r.isActive} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-sm text-muted-foreground">{t("settings_hint")} <Link href={`/t/${tenant}/settings?tab=operational`} className="underline">{t("settings_link")}</Link></p>
      </div>
    </>
  );
}

export default withIntl(ReturnReasonsPage, "app/t/[tenant]/returns/reasons/page.tsx");
