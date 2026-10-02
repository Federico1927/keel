/**
 * Minimal static server for the exported site (`out/`), used by `pnpm start` and the screenshot
 * script. Mirrors what a static host does: `/it/` → `out/it/index.html`, unknown → `404.html`.
 * Text files are compressed (brotli, else gzip; kept in memory after the first request) and hashed
 * Next assets are cached for a year: the Railway service serves the site with this file, and
 * uncompressed HTML and JS cost the page its mobile LCP.
 *
 *   pnpm --filter @keel/landing build && pnpm --filter @keel/landing start   # http://localhost:3100
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { extname, join, normalize } from "node:path";

const ROOT = join(process.cwd(), "out");
const PORT = Number(process.env.PORT ?? 3100);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    join(ROOT, clean),
    join(ROOT, clean, "index.html"),
    join(ROOT, `${clean.replace(/\/$/, "")}.html`),
  ];
  for (const c of candidates)
    if (c.startsWith(ROOT) && existsSync(c) && statSync(c).isFile())
      return { file: c, status: 200 };
  return { file: join(ROOT, "404.html"), status: 404 };
}

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".xml", ".txt"]);
const compressed = new Map();

function encoded(file, encoding) {
  const key = `${encoding}:${file}`;
  if (!compressed.has(key)) {
    const raw = readFileSync(file);
    compressed.set(
      key,
      encoding === "br"
        ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
        : gzipSync(raw, { level: 9 }),
    );
  }
  return compressed.get(key);
}

function cacheControl(urlPath) {
  if (urlPath.startsWith("/_next/static/")) return "public, max-age=31536000, immutable";
  if (urlPath.startsWith("/screenshots/")) return "public, max-age=86400";
  return "no-cache";
}

createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  const { file, status } = resolveFile(urlPath);
  const ext = extname(file);
  const headers = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": status === 200 ? cacheControl(urlPath) : "no-cache",
  };
  const accept = String(req.headers["accept-encoding"] ?? "");
  const encoding = !COMPRESSIBLE.has(ext)
    ? null
    : /\bbr\b/.test(accept)
      ? "br"
      : /\bgzip\b/.test(accept)
        ? "gzip"
        : null;
  if (encoding) {
    res.writeHead(status, { ...headers, "Content-Encoding": encoding, Vary: "Accept-Encoding" });
    res.end(encoded(file, encoding));
    return;
  }
  res.writeHead(status, headers);
  res.end(readFileSync(file));
}).listen(PORT, () => console.info(`[landing] serving ${ROOT} on http://localhost:${PORT}`));
