import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@hullwise/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import { requireUser } from "@/server/session";
import { BrandMark } from "@/components/brand-mark";
import { CompleteProfileForm } from "./form";

import { withIntl } from "@/i18n/intl-scope";
/** "Complete your profile": a person without a name (invited by email) gives it before the app opens. */
async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await requireUser();
  const { next } = await searchParams;
  const target = next && (next.startsWith("/t/") || next.startsWith("/admin")) ? next : "/";
  if (user.name?.trim()) redirect(target);
  const t = await getTranslations("welcome");
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
            <CardDescription>{t("description", { email: user.email })}</CardDescription>
          </CardHeader>
          <CardContent>
            <CompleteProfileForm next={target} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export default withIntl(WelcomePage, "app/welcome/page.tsx");
