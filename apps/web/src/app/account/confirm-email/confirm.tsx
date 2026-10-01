"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button } from "@keel/ui";
import { confirmEmailChangeAction } from "@/server/actions/profile";

export function ConfirmEmailButton({ token }: { token: string }) {
  const t = useTranslations("email_change");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: true; email: string } | { ok: false; error: string } | null>(null);
  if (result?.ok)
    return (
      <div className="space-y-3">
        <Alert variant="info" data-testid="email-confirmed">
          <AlertDescription>{t("done", { email: result.email })}</AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/">{t("continue")}</Link>
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      {result && !result.ok && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${["invalid_token", "expired_token", "email_taken"].includes(result.error) ? result.error : "invalid_token"}`)}</AlertDescription>
        </Alert>
      )}
      <Button
        className="w-full"
        disabled={pending}
        data-testid="confirm-email"
        onClick={() =>
          start(async () => {
            const r = await confirmEmailChangeAction(token);
            setResult(r.ok ? { ok: true, email: r.data!.email } : { ok: false, error: r.error });
          })
        }
      >
        {t("confirm")}
      </Button>
    </div>
  );
}
