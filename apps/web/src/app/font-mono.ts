import localFont from "next/font/local";

/**
 * Geist Mono without a preload (#49 performance). It only sets codes, ids and keys, never the text a
 * page paints first, so on a slow phone connection its 70 KB no longer compete with the page's own
 * files; it loads when a mono glyph is on screen (font-display: swap). Same file and settings as
 * `geist/font/mono` (re-exported by @hullwise/ui/fonts), read from @hullwise/ui's own dependency.
 */
export const GeistMono = localFont({
  src: "../../../../packages/ui/node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  preload: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Roboto Mono", "Menlo", "Monaco", "Liberation Mono", "DejaVu Sans Mono", "Courier New", "monospace"],
  weight: "100 900",
});
