"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label } from "@keel/ui";
import { sendMagicLink, signInWithPassword, type LoginState } from "./actions";

export function LoginForm({ initialError }: { initialError?: string }) {
  const t = useTranslations("auth");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [pwState, pwAction, pwPending] = useActionState<LoginState, FormData>(signInWithPassword, null);
  const [mlState, mlAction, mlPending] = useActionState<LoginState, FormData>(sendMagicLink, null);
  const state = mode === "password" ? pwState : mlState;

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          className={`flex-1 rounded-sm px-3 py-1.5 ${mode === "password" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
          onClick={() => setMode("password")}
        >
          {t("tab_password")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "magic"}
          className={`flex-1 rounded-sm px-3 py-1.5 ${mode === "magic" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
          onClick={() => setMode("magic")}
        >
          {t("tab_magic")}
        </button>
      </div>

      {(state?.error || initialError) && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${state?.error ?? initialError ?? "unknown"}`)}</AlertDescription>
        </Alert>
      )}
      {state?.sent && (
        <Alert variant="info">
          <AlertDescription>{t("magic_sent")}</AlertDescription>
        </Alert>
      )}

      {mode === "password" ? (
        <form action={pwAction} className="space-y-4" data-testid="login-password-form">
          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" className="w-full" disabled={pwPending}>
            {pwPending ? t("signing_in") : t("sign_in")}
          </Button>
        </form>
      ) : (
        <form action={mlAction} className="space-y-4" data-testid="login-magic-form">
          <div className="space-y-2">
            <Label htmlFor="email-magic">{t("email")}</Label>
            <Input id="email-magic" name="email" type="email" autoComplete="email" required />
          </div>
          <Button type="submit" className="w-full" disabled={mlPending}>
            {mlPending ? t("sending") : t("send_magic")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("magic_hint")}</p>
        </form>
      )}
    </div>
  );
}
