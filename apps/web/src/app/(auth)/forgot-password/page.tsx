import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/account/auth-shell";
import { ForgotPasswordForm } from "./form";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("account"))("forgot_title") };
}

/** "Forgot password?": one email field, one answer whatever the address (#52). */
async function ForgotPasswordPage() {
  const t = await getTranslations("account");
  return (
    <AuthShell title={t("forgot_title")} description={t("forgot_description")} testId="forgot-password">
      <ForgotPasswordForm />
    </AuthShell>
  );
}

export default withIntl(ForgotPasswordPage, "app/(auth)/forgot-password/page.tsx");
