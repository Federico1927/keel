import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb } from "@hullwise/db";
import { inspectPasswordReset } from "@hullwise/services";
import { Button } from "@hullwise/ui";
import { AuthShell } from "@/components/account/auth-shell";
import { ResetPasswordForm } from "./form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("account"))("reset_title") };
}

/** Landing page of the reset link: the form only for a live token, otherwise "ask for a new link". Opening it changes nothing. */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("account");
  const { state, email } = await inspectPasswordReset(adminDb(), token.slice(0, 200));
  if (state !== "valid")
    return (
      <AuthShell title={t(`reset_${state}_title`)} description={t(`reset_${state}_description`)} testId="reset-invalid">
        <Button asChild className="w-full">
          <Link href="/forgot-password">{t("reset_request_new")}</Link>
        </Button>
      </AuthShell>
    );
  return (
    <AuthShell title={t("reset_title")} description={t("reset_description", { email: email ?? "" })} testId="reset-password">
      <ResetPasswordForm token={token.slice(0, 200)} email={email} />
    </AuthShell>
  );
}
