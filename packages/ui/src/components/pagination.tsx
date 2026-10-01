import * as React from "react";
import { cn } from "../lib/cn";

/** Windowed page numbers; never renders an ellipsis for a single hidden page. */
export function getPageRange(page: number, pages: number, span = 2): (number | "…")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set<number>([1, pages]);
  for (let p = page - span; p <= page + span; p++) if (p >= 1 && p <= pages) set.add(p);
  if (page - span <= 3) for (let p = 2; p <= Math.min(pages, 2 + span * 2); p++) set.add(p);
  if (page + span >= pages - 2) for (let p = Math.max(1, pages - 1 - span * 2); p < pages; p++) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1];
    if (prev !== undefined && cur - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && cur - prev > 2) out.push("…");
    out.push(cur);
  }
  return out;
}

export function Pagination({ page, pageSize, total, hrefFor, summary, className }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string; summary: string; className?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1 && total <= pageSize) return <p className={cn("text-sm text-muted-foreground", className)}>{summary}</p>;
  return (
    <nav className={cn("flex flex-col items-center justify-between gap-3 sm:flex-row", className)} aria-label="pagination">
      <p className="text-sm text-muted-foreground">{summary}</p>
      <ul className="flex items-center gap-1 text-sm">
        <li>
          <a aria-disabled={page <= 1} className={cn("inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2", page <= 1 && "pointer-events-none opacity-40")} href={hrefFor(Math.max(1, page - 1))}>
            ‹
          </a>
        </li>
        {getPageRange(page, pages).map((p, i) => (
          <li key={`${p}-${i}`}>
            {p === "…" ? (
              <span className="px-1 text-muted-foreground">…</span>
            ) : (
              <a aria-current={p === page ? "page" : undefined} className={cn("inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 tabular", p === page && "bg-primary text-primary-foreground")} href={hrefFor(p)}>
                {p}
              </a>
            )}
          </li>
        ))}
        <li>
          <a aria-disabled={page >= pages} className={cn("inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2", page >= pages && "pointer-events-none opacity-40")} href={hrefFor(Math.min(pages, page + 1))}>
            ›
          </a>
        </li>
      </ul>
    </nav>
  );
}
