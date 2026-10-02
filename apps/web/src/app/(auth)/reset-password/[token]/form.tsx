"use client";
import { useActionState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { NewPasswordFields } from "@/components/account/password-fields";
import { resetPasswordAction } from "@/server/actions/account";
import { AccountErrorMessage } from "@/components/account/error-message";

export function ResetPasswordForm({ token, email }: { token: string; email: string | null }) {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState(resetPasswordAction.bind(null, token), null);
  const dead = state && !state.ok && ["expired_token", "used_token", "invalid_token"].includes(state.error);
  return (
    <form action={action} className="space-y-4" data-testid="reset-form">
      <NewPasswordFields email={email} />
      <p className="text-xs text-muted-foreground">{t("reset_sessions_hint")}</p>
      {state && !state.ok && <AccountErrorMessage state={state} />}
      {dead ? (
        <Button asChild className="w-full">
          <Link href="/forgot-password">{t("reset_request_new")}</Link>
        </Button>
      ) : (
        <Button type="submit" className="w-full" disabled={pending}>
          {t("reset_submit")}
        </Button>
      )}
    </form>
  );
}
