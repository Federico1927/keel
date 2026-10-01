import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatDate } from "@keel/core";
import { listReturnReasons, orderReturnContext, ReturnError } from "@keel/services";
import { PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { NewReturnForm } from "./form";

export default async function NewReturnPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ order?: string }> }) {
  const { tenant } = await params;
  const { order } = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  if (!canWritePage(ctx.role, "returns")) notFound();
  if (!order || !/^[0-9a-f-]{36}$/i.test(order)) notFound();
  const t = await getTranslations("return_new");
  let data;
  try {
    data = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      return { context: await orderReturnContext(s, ctx.settings, order), reasons: await listReturnReasons(s, true) };
    });
  } catch (e) {
    if (e instanceof ReturnError) notFound();
    throw e;
  }
  const { context, reasons } = data;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/orders/${order}`} className="hover:underline">← {context.order.name}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title", { order: context.order.name })} description={context.eligibility.deadline ? t("deadline", { date: formatDate(context.eligibility.deadline, ctx.locale, ctx.tenant.timezone), days: context.eligibility.daysLeft ?? 0 }) : t("description")} />
      <NewReturnForm slug={tenant} orderId={order} lines={context.lines.map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.quantity, returnable: l.returnable, alreadyReturned: l.alreadyReturned, unitNetMinor: l.unitNetMinor, excluded: l.excluded }))} reasons={reasons.map((r) => ({ code: r.code, label: r.label }))} eligible={context.eligibility.eligible} eligibilityReason={context.eligibility.reason} currency={context.order.currency} locale={ctx.locale} />
    </>
  );
}
