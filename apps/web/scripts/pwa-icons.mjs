/**
 * Regenerates the PWA icons in public/icons from the product mark (#49), in the light primary
 * token: `node scripts/pwa-icons.mjs`. Maskable icons keep the mark inside the safe zone.
 */
import sharp from "sharp";
const primary = "#2b59ff"; // TOKENS.light.primary
const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" ${pad ? "" : 'rx="8"'} fill="${primary}"/><g transform="${pad ? "translate(16 16) scale(0.72) translate(-16 -16)" : ""}" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 11.5c0 8.5 4.6 14 9.5 14s9.5-5.5 9.5-14"/><path d="M16 7v18.5"/><path d="M6.5 11.5h19"/></g></svg>`;
const out = process.argv[2] ?? new URL("../public/icons", import.meta.url).pathname;
for (const [name, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["maskable-512.png", 512, true], ["apple-touch-icon.png", 180, true]]) {
  await sharp(Buffer.from(mark(maskable)), { density: 1200 }).resize(size, size).png().toFile(`${out}/${name}`);
}
