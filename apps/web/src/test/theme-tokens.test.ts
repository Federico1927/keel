import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AA_TEXT, AA_UI, brandColorsFor, contrastRatio, mixColors } from "@keel/core";
import { BRAND_SURFACES, THEMES, TOKENS, type Theme, type ThemeTokens } from "@keel/ui/tokens";

/** Parses the custom properties of one rule block of tokens.css. */
function cssBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector ${selector} not found`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const css = readFileSync(path.resolve(__dirname, "../../../../packages/ui/src/tokens.css"), "utf8");
const blocks: Record<Theme, Record<string, string>> = { light: cssBlock(css, ".light"), dark: cssBlock(css, ".dark") };

describe("design tokens", () => {
  it.each(THEMES)("tokens.css matches tokens.ts (%s)", (theme) => {
    for (const [name, value] of Object.entries(TOKENS[theme])) expect(blocks[theme][name], `--${name}`).toBe(value);
  });

  describe.each(THEMES)("WCAG AA in the %s theme", (theme) => {
    const t: ThemeTokens = TOKENS[theme];
    const surfaces = [t.bg, t.surface, t["surface-2"]];
    const expectAll = (fg: string, bgs: string[], min: number, label: string) => {
      for (const bg of bgs) expect(contrastRatio(fg, bg), `${label}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    };
    it("body and secondary text on every surface", () => {
      expectAll(t.fg, surfaces, AA_TEXT, "fg");
      expectAll(t.muted, surfaces, AA_TEXT, "muted");
      expectAll(t["sidebar-fg"], [t.sidebar, t["sidebar-accent"]], AA_TEXT, "sidebar-fg");
      expectAll(t["sidebar-muted"], [t.sidebar, t["sidebar-accent"]], AA_TEXT, "sidebar-muted");
    });
    it("primary as fill, as link text and as focus ring", () => {
      expectAll(t["on-primary"], [t.primary], AA_TEXT, "on-primary");
      expectAll(t.primary, surfaces, AA_TEXT, "primary text");
    });
    it.each(["success", "warning", "danger", "info", "platform"] as const)("%s as text, as badge on its tint and as fill", (k) => {
      const tints = [mixColors(t[k], t.surface, 0.15), mixColors(t[k], t.bg, 0.15)];
      expectAll(t[k], [...surfaces, ...tints], AA_TEXT, k);
      expectAll(t[`on-${k}`], [t[k]], AA_TEXT, `on-${k}`);
    });
    it("control boundaries and chart marks reach 3:1", () => {
      expectAll(t["line-strong"], [t.bg, t.surface], AA_UI, "line-strong");
      for (const k of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"] as const) expectAll(t[k], [t.surface, t["surface-2"]], AA_UI, k);
    });
  });

  it.each(["#2b59ff", "#ffd600", "#3d5a40", "#1f3a5f", "#e11d48", "#000000", "#ffffff"])("a tenant brand colour %s is made AA-safe in both themes", (brand) => {
    for (const theme of THEMES) {
      const b = brandColorsFor(brand, BRAND_SURFACES[theme]);
      expect(contrastRatio(b.primary, b.onPrimary)).toBeGreaterThanOrEqual(AA_TEXT);
      for (const s of BRAND_SURFACES[theme].surfaces) expect(contrastRatio(b.primary, s)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
