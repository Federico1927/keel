"use client";
import { useActionState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label } from "@keel/ui";
import { requestPasswordResetAction } from "@/server/actions/account";

export function ForgotPasswordForm() {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState(requestPasswordResetAction, null);
  if (state?.ok)
    return (
      <div className="space-y-4">
        <Alert variant="info" data-testid="forgot-sent">
          <AlertDescription>{t("forgot_sent")}</AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">{t("back_to_login")}</Link>
        </Button>
      </div>
    );
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="forgot-email">{t("email")}</Label>
        <Input id="forgot-email" name="email" type="email" autoComplete="email" required autoFocus maxLength={254} />
      </div>
      {state && !state.ok && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${state.error === "rate_limited" ? "rate_limited" : "invalid_email"}`)}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("sending") : t("forgot_submit")}
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="text-muted-foreground hover:text-foreground hover:underline">
          {t("back_to_login")}
        </Link>
      </p>
    </form>
  );
}
