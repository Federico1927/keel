import { NextResponse, type NextRequest } from "next/server";
import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, isLocale, isTenantOperational, type Locale } from "@keel/config";
import { adminDb, eq, schema, withTenant } from "@keel/db";
import { getPortalConfig, returnLabelPdf, verifyReturnLink } from "@keel/services";
import { loadMessages } from "@/i18n/messages";

/** The prepaid return label as a PDF, reachable only through the signed link given to the customer. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const [tenant] = await adminDb().select({ id: schema.tenants.id, defaultLocale: schema.tenants.defaultLocale, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (!tenant || !isTenantOperational(tenant.status) || !verifyReturnLink(tenant.id, id, sig)) return new NextResponse("not found", { status: 404 });
  const lang = req.nextUrl.searchParams.get("lang");
  const locale: Locale = isLocale(lang) ? lang : isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const t = createTranslator({ locale, messages: await loadMessages(locale), namespace: "return_portal.label" as never }) as unknown as (k: string) => string;
  const pdf = await withTenant(tenant.id, async (tx) => {
    const ctx = { tenantId: tenant.id, tx, actor: { type: "system" as const, userId: null } };
    const config = await getPortalConfig(ctx);
    return returnLabelPdf(ctx, id, { title: t("title"), from: t("from"), to: t("to"), reference: t("reference"), carrier: t("carrier"), tracking: t("tracking"), instructions: t("instructions") }, config.returnLabel.destination);
  });
  if (!pdf) return new NextResponse("not found", { status: 404 });
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
}
