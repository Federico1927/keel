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
});
