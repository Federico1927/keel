/**
 * Direction A fonts, self-hosted from the `geist` package through next/font/local: the woff2
 * files ship in node_modules, so builds need no network and every machine renders the same
 * glyphs (Latin and Latin Extended, enough for en/it/es). Apply both `variable` classes on
 * <html>; tokens.css reads `--font-geist-sans` and `--font-geist-mono`.
 */
export { GeistSans } from "./font-sans";
export { GeistMono } from "geist/font/mono";
