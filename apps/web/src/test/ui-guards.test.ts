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
 * Pages (#49) still hiding table columns on phones, to move to <DataList>: since wave 3 only the
 * super-admin console, migrated separately.
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
