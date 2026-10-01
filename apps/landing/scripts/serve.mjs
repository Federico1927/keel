/**
 * Minimal static server for the exported site (`out/`), used by `pnpm start` and the screenshot
 * script. Mirrors what a static host does: `/it/` → `out/it/index.html`, unknown → `404.html`.
 *
 *   pnpm --filter @keel/landing build && pnpm --filter @keel/landing start   # http://localhost:3100
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
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

createServer((req, res) => {
  const { file, status } = resolveFile(req.url ?? "/");
  res.writeHead(status, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.info(`[landing] serving ${ROOT} on http://localhost:${PORT}`));
