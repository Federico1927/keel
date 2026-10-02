/**
 * Several ad accounts on one platform (#82). Rows synced before accounts existed carry no account:
 * they belong to the platform's primary account (the one on the integration row).
 */

/** Meta ad account ids as the Marketing API addresses them: `act_<digits>`. */
export function normalizeMetaAccountId(id: string): string {
  const v = id.trim();
  return v.startsWith("act_") ? v : `act_${v}`;
}

/** The account a campaign (or ad set, ad, metric, attribution row) belongs to: its own, or the primary one when it predates accounts. */
export function accountOf(rowAccount: string | null | undefined, primary: string | null): string | null {
  return rowAccount || primary;
}

/** Whether a row passes an account filter (`null` filter: every account). */
export function matchesAccountFilter(rowAccount: string | null | undefined, filter: string | null | undefined, primary: string | null): boolean {
  if (!filter) return true;
  return accountOf(rowAccount, primary) === filter;
}

export interface AdAccountRunResult {
  account: string;
  ok: boolean;
  error: string | null;
  rows: number;
}

/** One line for the job history: a failing account is reported, never blocks the others; the job fails only when every account failed. */
export function summarizeAccountRuns(results: readonly AdAccountRunResult[]): { ok: number; failed: { account: string; error: string }[]; rows: number; allFailed: boolean } {
  const failed = results.filter((r) => !r.ok).map((r) => ({ account: r.account, error: r.error ?? "unknown error" }));
  return { ok: results.length - failed.length, failed, rows: results.reduce((s, r) => s + r.rows, 0), allFailed: results.length > 0 && failed.length === results.length };
}
