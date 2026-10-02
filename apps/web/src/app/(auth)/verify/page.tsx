import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";

export default async function VerifyPage() {
  const t = await getTranslations("auth");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{t("verify_title")}</CardTitle>
          <CardDescription>{t("verify_description")}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t("magic_hint")}</CardContent>
      </Card>
    </main>
  );
}
