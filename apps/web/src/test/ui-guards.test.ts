import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/**
 * Tier 2/3 pages (#49) still hiding table columns on phones, to move to <DataList> in waves 2 and 3.
 * Shrink this list, never grow it: a new list renders through DataList, which shows every column on
 * the phone card instead of hiding it.
 */
const HIDDEN_CELL_ALLOWLIST = new Set([
  "app/admin/alerts/page.tsx",
  "app/admin/billing/page.tsx",
  "app/admin/billing/subscriptions/page.tsx",
  "app/admin/integrations/page.tsx",
  "app/admin/jobs/page.tsx",
  "app/admin/mcp/page.tsx",
  "app/admin/metrics/page.tsx",
  "app/admin/support/page.tsx",
  "app/admin/tenants/page.tsx",
  "app/admin/users/[id]/page.tsx",
  "app/admin/users/page.tsx",
  "app/t/[tenant]/analytics/alerts/page.tsx",
  "app/t/[tenant]/analytics/depth.tsx",
  "app/t/[tenant]/analytics/money.tsx",
  "app/t/[tenant]/analytics/page.tsx",
  "app/t/[tenant]/analytics/payouts/page.tsx",
  "app/t/[tenant]/audit/page.tsx",
  "app/t/[tenant]/campaigns/[id]/ads/[adId]/page.tsx",
  "app/t/[tenant]/campaigns/[id]/page.tsx",
  "app/t/[tenant]/campaigns/ads-table.tsx",
  "app/t/[tenant]/campaigns/creatives/page.tsx",
  "app/t/[tenant]/campaigns/ledger/page.tsx",
  "app/t/[tenant]/campaigns/recommendations/page.tsx",
  "app/t/[tenant]/campaigns/words/page.tsx",
  "app/t/[tenant]/cod/settings/page.tsx",
  "app/t/[tenant]/cod/team/page.tsx",
  "app/t/[tenant]/customers/[id]/page.tsx",
  "app/t/[tenant]/customers/page.tsx",
  "app/t/[tenant]/customers/predictions/page.tsx",
  "app/t/[tenant]/customers/rfm/page.tsx",
  "app/t/[tenant]/discounts/page.tsx",
  "app/t/[tenant]/discounts/pools/[id]/page.tsx",
  "app/t/[tenant]/exports/page.tsx",
  "app/t/[tenant]/integrations/page.tsx",
  "app/t/[tenant]/integrations/tracking/page.tsx",
  "app/t/[tenant]/inventory/losses/page.tsx",
  "app/t/[tenant]/inventory/markdowns/controls.tsx",
  "app/t/[tenant]/inventory/markdowns/page.tsx",
  "app/t/[tenant]/inventory/planning/controls.tsx",
  "app/t/[tenant]/inventory/planning/page.tsx",
  "app/t/[tenant]/notifications/suppressions/page.tsx",
  "app/t/[tenant]/products/[id]/costs-form.tsx",
  "app/t/[tenant]/products/[id]/supplier-section.tsx",
  "app/t/[tenant]/products/import-costs/import-form.tsx",
  "app/t/[tenant]/products/quality/page.tsx",
  "app/t/[tenant]/purchasing/mix/[productId]/page.tsx",
  "app/t/[tenant]/purchasing/mix/[productId]/planner.tsx",
  "app/t/[tenant]/purchasing/page.tsx",
  "app/t/[tenant]/purchasing/po-editor.tsx",
  "app/t/[tenant]/purchasing/suppliers/page.tsx",
  "app/t/[tenant]/returns/analytics/page.tsx",
  "app/t/[tenant]/segments/[id]/destinations.tsx",
  "app/t/[tenant]/segments/[id]/page.tsx",
  "app/t/[tenant]/segments/campaigns/[id]/page.tsx",
  "app/t/[tenant]/segments/campaigns/page.tsx",
  "app/t/[tenant]/segments/page.tsx",
  "app/t/[tenant]/settings/ai/page.tsx",
  "app/t/[tenant]/settings/billing/page.tsx",
  "app/t/[tenant]/support/page.tsx",
  "components/data-export/export-table.tsx",
  "components/mcp/connections.tsx",
  "components/profile/profile-view.tsx",
]);

describe("UI guards", () => {
  it("every dropdown uses the shared Select (no raw <select> in apps/web)", () => {
    const offenders = files(SRC).filter((f) => /<select[\s>]/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no Select or Input sets its own height: use size=\"sm\" | \"default\"", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<(Select|Input)\b[^>]*?className="([^"]*)"/g)) if (/(^|\s)h-(8|9|10)(\s|$)/.test(m[2]!)) offenders.push(`${path.relative(SRC, f)}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no column is hidden on phones with `hidden *:table-cell` outside the allow-list: use DataList (#49)", () => {
    const offenders = files(SRC).map((f) => path.relative(SRC, f).split(path.sep).join("/")).filter((f) => /\bhidden\s+(?:[\w-]+\s+)*(sm|md|lg|xl|2xl):table-cell/.test(readFileSync(path.join(SRC, f), "utf8")) && !HIDDEN_CELL_ALLOWLIST.has(f));
    expect(offenders).toEqual([]);
  });

  it("the allow-list only names files that still need it", () => {
    const stale = [...HIDDEN_CELL_ALLOWLIST].filter((f) => { try { return !/(sm|md|lg|xl|2xl):table-cell/.test(readFileSync(path.join(SRC, f), "utf8")); } catch { return true; } });
    expect(stale).toEqual([]);
  });
});
