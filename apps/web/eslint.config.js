import next from "@keel/eslint-config/next";

/**
 * Colours come only from the design tokens (packages/ui/src/tokens.css, issue #44): no Tailwind
 * palette classes (bg-red-500, text-white…), no hex/rgb/hsl literals, in markup and in charts.
 * Use the token classes (bg-primary, text-destructive…) or `var(--…)` / the chart theme helpers.
 */
const PALETTE = "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}|white|black";
const UTILITY = "(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|placeholder|accent|caret|shadow|ring-offset)";
const paletteClass = `(?:^|[\\s:"'\`])${UTILITY}-(?:${PALETTE})(?:\\/\\d+)?(?=$|[\\s"'\`])`;
const colourLiteral = "(?:^|[^&\\w])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z])|\\b(?:rgba?|hsla?)\\(";
const message = "Use design tokens (bg-primary, text-muted-foreground, var(--chart-1)…) instead of raw colours.";

export default [
  ...next,
  { ignores: [".next/**", "next-env.d.ts", "playwright-report/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=/${paletteClass}/]`, message },
        { selector: `TemplateElement[value.raw=/${paletteClass}/]`, message },
        { selector: `Literal[value=/${colourLiteral}/]`, message },
        { selector: `TemplateElement[value.raw=/${colourLiteral}/]`, message },
      ],
    },
  },
];
