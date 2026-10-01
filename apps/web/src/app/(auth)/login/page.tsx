import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { PRODUCT_NAME } from "@keel/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getCurrentUser } from "@/server/session";
import { LoginForm } from "./login-form";
import { BrandMark } from "@/components/brand-mark";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  const { error } = await searchParams;
  if (user && error !== "no_tenant") redirect("/");
  const t = await getTranslations("auth");
  const knownErrors = new Set(["no_tenant", "invalid_credentials", "unknown", "invalid_input", "Verification", "Configuration"]);
  const initialError = error && knownErrors.has(error) ? (error === "Verification" || error === "Configuration" ? "unknown" : error) : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-9 w-9" />
            <div>
              <p className="text-xs font-medium text-muted-foreground">{PRODUCT_NAME}</p>
              <h1 className="text-2xl">{t("title")}</h1>
            </div>
          </div>
          <LocaleSwitcher />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("card_title")}</CardTitle>
            <CardDescription>{t("card_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm initialError={initialError} />
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">{t("demo_hint")}</p>
      </div>
    </main>
  );
}
