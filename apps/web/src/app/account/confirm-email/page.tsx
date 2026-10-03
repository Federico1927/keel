import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@hullwise/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import { BrandMark } from "@/components/brand-mark";
import { ConfirmEmailButton } from "./confirm";

import { withIntl } from "@/i18n/intl-scope";
export const dynamic = "force-dynamic";

/**
 * Landing page of the link sent to a new email address. The change happens on the button (a POST),
 * not on opening the link, so mail scanners that prefetch links cannot confirm it.
 */
async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = await getTranslations("email_change");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>{token ? <ConfirmEmailButton token={token.slice(0, 200)} /> : <p className="text-sm text-destructive">{t("errors.invalid_token")}</p>}</CardContent>
        </Card>
      </div>
    </main>
  );
}

export default withIntl(ConfirmEmailPage, "app/account/confirm-email/page.tsx");
