import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead, cn } from "@keel/ui";

/** Console tables keep filters, search, sort and page in the URL (#48): a link is the state. */
export type Query = Record<string, string | undefined>;

export function queryHref(base: string, current: Query, over: Query = {}): string {
  const q = new URLSearchParams(Object.entries({ ...current, ...over }).filter((e): e is [string, string] => Boolean(e[1])));
  return `${base}${q.size ? `?${q}` : ""}`;
}

/** First value of each search param, as the pages receive them. */
export function flatParams(sp: Record<string, string | string[] | undefined>): Query {
  return Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}

/** Column header that sorts the list server side; a second click flips the direction. */
export function SortHead({ label, column, sort, dir, base, query, defaultDir = "asc", className }: { label: string; column: string; sort: string; dir: "asc" | "desc"; base: string; query: Query; defaultDir?: "asc" | "desc"; className?: string }) {
  const active = sort === column;
  const next = active ? (dir === "asc" ? "desc" : "asc") : defaultDir;
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={queryHref(base, query, { sort: column, dir: next, page: undefined })} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")} data-testid={`sort-${column}`}>
        {label} <Icon className={cn("h-3 w-3", !active && "opacity-40")} />
      </Link>
    </TableHead>
  );
}
