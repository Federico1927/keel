import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function files(dir: string, ext = /\.tsx$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(p) ? [p] : [];
  });
}

/**
 * A column hidden on phones (`hidden md:table-cell` and its variants) is a fact a phone user never
 * sees (#49): lists render through `DataList`, which turns every column into a line of the phone card.
 * The check reads each source line as class tokens, so the order of the classes, other classes in
 * between, `cn()` arguments on one line and variant prefixes (`sm:`…`2xl:`, `min-[…]:`, `group-…:`)
 * are all caught. Only DataList itself (packages/ui) may lay out cells per breakpoint.
 */
const BREAKPOINT_CELL = /^(?:[\w-]+:)*(?:sm|md|lg|xl|2xl|min-\[[^\]]+\]|@[\w-]+):table-cell$/;
function hidesCellOnPhones(source: string): boolean {
  return source.split("\n").some((line) => {
    const tokens = line.split(/[\s"'`,{}()]+/);
    return tokens.includes("hidden") && tokens.some((tok) => BREAKPOINT_CELL.test(tok));
  });
}
const UI_SRC = path.resolve(SRC, "../../../packages/ui/src");

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

  it("the hidden-column check catches every breakpoint and class order", () => {
    for (const bad of ['className="hidden md:table-cell"', 'className="text-right hidden sm:table-cell"', 'className="hidden text-xs hover:underline lg:table-cell"', 'className="xl:table-cell hidden"', 'cn("hidden", "2xl:table-cell")', "className={`hidden ${x} md:table-cell`}", 'className="hidden min-[900px]:table-cell"']) expect(hidesCellOnPhones(bad), bad).toBe(true);
    for (const ok of ['className="max-md:hidden"', 'className="md:table-cell"', 'className="hidden md:block"', 'className="md:hidden"']) expect(hidesCellOnPhones(ok), ok).toBe(false);
  });

  it("no column is hidden on phones with `hidden *:table-cell`, in apps/web or the shared UI outside DataList: use DataList (#49)", () => {
    const web = files(SRC, /\.tsx?$/).filter((f) => !/\.test\.tsx?$/.test(f)).map((f) => path.relative(SRC, f));
    const ui = files(UI_SRC, /\.tsx?$/).filter((f) => !/data-list(\.test)?\.tsx$/.test(f)).map((f) => `packages/ui/${path.relative(UI_SRC, f)}`);
    const offenders = [...web.filter((f) => hidesCellOnPhones(readFileSync(path.join(SRC, f), "utf8"))), ...ui.filter((f) => hidesCellOnPhones(readFileSync(path.join(UI_SRC, f.slice("packages/ui/".length)), "utf8")))];
    expect(offenders).toEqual([]);
  });
});
