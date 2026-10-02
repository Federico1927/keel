/**
 * Password strength rules for the profile's "change password": long enough, not a common
 * password, not built on the person's own name or email, and with some variety. Pure.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const PASSWORD_ISSUES = ["too_short", "too_long", "too_common", "personal", "low_variety"] as const;
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number];

const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "123456789", "1234567890", "12345678910", "qwertyuiop", "qwerty123", "iloveyou", "letmein123", "welcome123", "admin12345", "abc1234567", "1q2w3e4r5t", "zaq12wsx", "football123", "monkey1234", "dragon1234", "sunshine12", "princess12", "baseball12", "superman12", "trustno1", "changeme123", "hullwise-demo-2026",
]);

export function checkPassword(password: string, person: { email?: string | null; name?: string | null } = {}): { ok: boolean; issues: PasswordIssue[] } {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push("too_short");
  if (password.length > PASSWORD_MAX_LENGTH) issues.push("too_long");
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(0123456789|1234567890|abcdefghij)/.test(lower)) issues.push("too_common");
  const personal = [person.email?.split("@")[0], ...(person.name ?? "").split(/\s+/)].map((s) => (s ?? "").toLowerCase()).filter((s) => s.length >= 4);
  if (personal.some((p) => lower.includes(p))) issues.push("personal");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 3) issues.push("low_variety");
  return { ok: issues.length === 0, issues };
}
