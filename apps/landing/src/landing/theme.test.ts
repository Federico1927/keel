import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOKENS } from "@keel/ui/tokens";

const landingCss = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
const themeCss = readFileSync(
  path.resolve(__dirname, "../../../../packages/ui/src/theme.css"),
  "utf8",
);
const appCss = readFileSync(
  path.resolve(__dirname, "../../../../packages/ui/src/styles.css"),
  "utf8",
);

/** #47: one token file for the app and the landing; changing a colour in packages/ui changes both. */
describe("shared direction A theme", () => {
  it("the landing and the app import the same theme file", () => {
    expect(landingCss).toMatch(/@import "@keel\/ui\/theme\.css";/);
    expect(appCss).toMatch(/@import "\.\/theme\.css";/);
    expect(themeCss).toMatch(/@import "\.\/tokens\.css";/);
  });
  it("the landing redefines no shared token or Tailwind colour, font or radius", () => {
    const declared = [...landingCss.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!);
    const shared = new Set([
      ...Object.keys(TOKENS.light),
      ...[...themeCss.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    ]);
    expect(declared.filter((d) => shared.has(d))).toEqual([]);
    expect(declared.filter((d) => /^(color-(?!hero-)|font-|radius-)/.test(d))).toEqual([]);
  });
  it("no serif and no font package of its own", () => {
    expect(landingCss).not.toMatch(/serif|@fontsource/i);
  });
});
