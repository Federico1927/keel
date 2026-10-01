/**
 * Converts the product captures (PNG, 2x) into the WebP sizes the landing serves, per locale.
 *
 *   pnpm --filter @keel/landing images
 *   CAPTURE_DIR=/path/to/pngs pnpm --filter @keel/landing images
 *
 * Reads `<CAPTURE_DIR>/<locale>/<name>.png` for every entry of src/config/screenshots.ts and writes
 * `public/screenshots/<locale>/<name>-<width>.webp`.
 */
import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.env.CAPTURE_DIR ?? "./screenshots-src");
const OUT = resolve("./public/screenshots");
const LOCALES = (process.env.LOCALES ?? "en,it").split(",");
const QUALITY = Number(process.env.WEBP_QUALITY ?? 82);

/** Parse the TS config without a TS toolchain: the file is simple enough for two regexes. */
function readConfig() {
  const ts = readFileSync(resolve("./src/config/screenshots.ts"), "utf8");
  const roles = {};
  for (const m of ts.matchAll(/(\w+): \{ widths: \[([\d, ]+)\] \}/g))
    roles[m[1]] = m[2].split(",").map((s) => Number(s.trim()));
  const shots = {};
  const block = ts.slice(ts.indexOf("SCREENSHOTS"), ts.indexOf("};", ts.indexOf("SCREENSHOTS")));
  for (const m of block.matchAll(/"?([\w-]+)"?: "(\w+)"/g)) shots[m[1]] = m[2];
  return { roles, shots };
}

async function main() {
  const { roles, shots } = readConfig();
  let missing = 0;
  for (const locale of LOCALES) {
    mkdirSync(`${OUT}/${locale}`, { recursive: true });
    for (const [name, role] of Object.entries(shots)) {
      const input = `${SRC}/${locale}/${name}.png`;
      if (!existsSync(input)) {
        console.warn(`[images] missing ${input}`);
        missing++;
        continue;
      }
      for (const width of roles[role]) {
        const output = `${OUT}/${locale}/${name}-${width}.webp`;
        const info = await sharp(input)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: QUALITY, effort: 6 })
          .toFile(output);
        console.info(
          `[images] ${output} ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)}kB`,
        );
      }
    }
  }
  if (missing) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
