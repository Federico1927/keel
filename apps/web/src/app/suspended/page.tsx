import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";

export default async function SuspendedPage() {
  const t = await getTranslations("shell");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{t("suspended_title")}</CardTitle>
          <CardDescription>{t("suspended_description")}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  );
}
