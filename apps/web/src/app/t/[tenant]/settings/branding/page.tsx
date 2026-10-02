import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { Button, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { loadBrand } from "@/server/branding";
import { BrandingForm } from "./forms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("branding"))("title") };
}

/** Settings → Branding (#44): brand colour and logos, the default for every tenant-branded page. */
export default async function BrandingPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("branding");
  const brand = await loadBrand(ctx.tenant.id, ctx.tenant.slug);
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild variant="outline">
            <Link href={`/t/${tenant}/settings`}>{t("back")}</Link>
          </Button>
        }
      />
      <BrandingForm slug={ctx.tenant.slug} tenantName={ctx.tenant.name} canEdit={canDo(ctx.role, "manage_settings")} brandColor={brand.brandColor} logoLight={brand.logoLight} logoDark={brand.logoDark} />
    </>
  );
}
