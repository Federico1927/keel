"use client";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@hullwise/ui";
import type { ActionResult } from "@/server/action-result";

const KNOWN = new Set(["invalid_input", "rate_limited", "weak_password", "password_mismatch", "invalid_token", "expired_token", "used_token", "revoked_token", "privacy_required", "account_exists", "email_mismatch", "not_found", "forbidden", "already_member", "not_pending"]);

/** Error of an account action, with the password rules that failed when the password is weak. */
export function AccountErrorMessage({ state }: { state: ActionResult<unknown> }) {
  const t = useTranslations("account");
  const tp = useTranslations("profile");
  if (state.ok) return null;
  const issues = state.fieldErrors ? Object.keys(state.fieldErrors) : [];
  return (
    <Alert variant="destructive" data-testid="account-error">
      <AlertDescription>
        {t(`errors.${KNOWN.has(state.error) ? state.error : "unknown"}`)}
        {issues.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {issues.map((i) => (
              <li key={i}>{tp(`password_issues.${i}`)}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
