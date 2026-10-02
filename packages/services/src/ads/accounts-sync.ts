import { isMultiAccountAdPlatform } from "@hullwise/config";
import type { AdAccountRunResult, AdPlatform } from "@hullwise/core";
import type { TenantRunner } from "../assistant";
import { getAdsPlatformFor, type PlatformTenant } from "../integrations/factory";
import { runAdsSync } from "../sync";
import { adAccountsToSync, type AdAccountScope } from "./accounts";
import { runAdsEntitySync } from "./sync";

export interface AccountsSyncResult {
  results: AdAccountRunResult[];
  campaigns: number;
  metrics: number;
  /** Entity runs that paused (time budget or rate limit): the job re-enqueues each account alone. */
  paused: { account: AdAccountScope | null; rateLimited: boolean; retryAfterMs: number | null }[];
  /** Nothing pulled: the account asked for is not connected. */
  skipped: "account_not_connected" | null;
}

/**
 * One ads pull of a platform (#82): every connected Meta ad account in turn, or the one asked for;
 * a single pull on platforms without accounts. Each account runs in its own short transactions, so
 * a failing one (expired token, rate limit, outage) is recorded on its row and health source and
 * the next account still runs.
 */
export async function runAdsSyncForAccounts(run: TenantRunner, tenant: PlatformTenant, provider: AdPlatform, opts: { since: string; until: string; phase?: "campaigns" | "entities"; kind?: "delta" | "backfill"; account?: string | null; minImpressions?: number; budgetMs?: number; entities?: boolean }): Promise<AccountsSyncResult> {
  const out: AccountsSyncResult = { results: [], campaigns: 0, metrics: 0, paused: [], skipped: null };
  const accounts: (AdAccountScope | null)[] = isMultiAccountAdPlatform(provider) ? await run((ctx) => adAccountsToSync(ctx, provider, opts.account)) : [];
  if (!accounts.length) {
    if (opts.account) return { ...out, skipped: "account_not_connected" };
    accounts.push(null);
  }
  for (const account of accounts) {
    const label = account?.externalId ?? provider;
    try {
      if (opts.phase !== "entities") {
        const r = await run(async (ctx) => runAdsSync(ctx, await getAdsPlatformFor(ctx, tenant, provider, { account: account?.externalId }), { since: opts.since, until: opts.until }, { account }));
        out.campaigns += r.campaigns;
        out.metrics += r.metrics;
        if (r.error) {
          out.results.push({ account: label, ok: false, error: r.error, rows: r.campaigns + r.metrics });
          continue;
        }
        if (opts.entities === false) {
          out.results.push({ account: label, ok: true, error: null, rows: r.campaigns + r.metrics });
          continue;
        }
      }
      const e = await run(async (ctx) => runAdsEntitySync(ctx, await getAdsPlatformFor(ctx, tenant, provider, { account: account?.externalId }), { since: opts.since, until: opts.until, kind: opts.kind ?? "delta", budgetMs: opts.budgetMs ?? 25_000, minImpressions: opts.minImpressions, account }));
      if (!e.finished && !e.error) out.paused.push({ account, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs });
      out.results.push({ account: label, ok: !e.error, error: e.error, rows: e.rows });
    } catch (err) {
      out.results.push({ account: label, ok: false, error: err instanceof Error ? err.message : String(err), rows: 0 });
    }
  }
  return out;
}
