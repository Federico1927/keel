"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input, Label, cn } from "@hullwise/ui";
import { PASSWORD_ISSUES, checkPassword } from "@hullwise/core";

/** New password + confirmation with a live strength check (the server checks again with the same rules). */
export function NewPasswordFields({ email, name, required = true }: { email?: string | null; name?: string | null; required?: boolean }) {
  const t = useTranslations("account");
  const tp = useTranslations("profile");
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const { issues } = checkPassword(value, { email, name });
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="new-password">{t("new_password")}</Label>
        <Input id="new-password" name="password" type="password" autoComplete="new-password" required={required} maxLength={200} value={value} onChange={(e) => setValue(e.target.value)} aria-describedby="password-checks" />
      </div>
      <ul id="password-checks" className="space-y-0.5 text-xs" aria-live="polite" data-testid="password-checks">
        {PASSWORD_ISSUES.filter((i) => i !== "too_long" || issues.includes(i)).map((i) => {
          const okNow = value.length > 0 && !issues.includes(i);
          return (
            <li key={i} className={cn("flex items-center gap-1.5", okNow ? "text-success" : "text-muted-foreground")}>
              <span aria-hidden>{okNow ? "✓" : "○"}</span>
              {tp(`password_issues.${i}`)}
            </li>
          );
        })}
      </ul>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">{t("confirm_password")}</Label>
        <Input id="confirm-password" name="confirm" type="password" autoComplete="new-password" required={required} maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {confirm.length > 0 && confirm !== value && <p className="text-xs text-destructive">{t("errors.password_mismatch")}</p>}
      </div>
    </div>
  );
}
