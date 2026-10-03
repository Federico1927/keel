import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";

import { withIntl } from "@/i18n/intl-scope";
const REASONS = ["payment", "platform", "churned"] as const;

/** Where a suspended or churned tenant's users land (#48); the reason only picks the message. */
async function SuspendedPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const t = await getTranslations("shell");
  const { reason } = await searchParams;
  const r = (REASONS as readonly string[]).includes(reason ?? "") ? (reason as (typeof REASONS)[number]) : "payment";
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="max-w-md" data-testid="suspended" data-reason={r}>
        <CardHeader>
          <CardTitle>{r === "churned" ? t("churned_title") : t("suspended_title")}</CardTitle>
          <CardDescription>{r === "payment" ? t("suspended_description") : r === "churned" ? t("churned_description") : t("suspended_platform_description")}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  );
}

export default withIntl(SuspendedPage, "app/suspended/page.tsx");
