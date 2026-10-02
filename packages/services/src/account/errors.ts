import type { PasswordIssue } from "@keel/core";

export type AccountErrorCode =
  | "not_found"
  | "invalid_input"
  | "rate_limited"
  | "wrong_password"
  | "weak_password"
  | "email_taken"
  | "same_email"
  | "invalid_token"
  | "expired_token"
  | "used_token"
  | "revoked_token"
  | "already_member"
  | "not_pending"
  | "forbidden"
  | "email_mismatch"
  | "account_exists"
  | "privacy_required";

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    readonly issues: PasswordIssue[] = [],
  ) {
    super(code);
    this.name = "AccountError";
  }
}
