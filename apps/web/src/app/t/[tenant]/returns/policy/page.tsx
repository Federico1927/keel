import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { getReturnPolicy, listReturnReasons } from "@hullwise/services";
import { and, eq, schema, sql } from "@hullwise/db";
import { PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { PolicyForm } from "./form";

export default async function ReturnPolicyPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "returns");
  if (!canWritePage(ctx.role, "returns")) notFound();
  const t = await getTranslations("return_policy");
  const { policy, reasons, types, tags } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const types = await tx.selectDistinct({ v: schema.products.productType }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), sql`${schema.products.productType} is not null`));
    const tags = await tx.execute<{ tag: string }>(sql`select distinct unnest(tags) as tag from products where tenant_id = ${ctx.tenant.id} order by 1 limit 200`);
    return { policy: await getReturnPolicy(s), reasons: await listReturnReasons(s, true), types: types.map((x) => x.v!).sort(), tags: tags.rows.map((r) => r.tag) };
  });
  return (
    <>
      <Link href={`/t/${tenant}/returns`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: ctx.settings.returnWindowDays })} />
      <PolicyForm slug={tenant} initial={policy} currency={ctx.tenant.currency} reasons={reasons.map((r) => ({ code: r.code, label: r.label }))} productTypes={types} tags={tags} />
    </>
  );
}
