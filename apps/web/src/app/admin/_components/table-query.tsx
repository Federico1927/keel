import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@hullwise/ui";

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

export interface SortProps { sort: string; dir: "asc" | "desc"; base: string; query: Query }
export interface SortOption { label: string; column: string; defaultDir?: "asc" | "desc" }

/** Where a sort link leads: the same column flips its direction, another one starts from its default. */
export function sortTarget({ sort, dir, base, query }: SortProps, { column, defaultDir = "asc" }: SortOption) {
  const active = sort === column;
  const next = active ? (dir === "asc" ? "desc" : "asc") : defaultDir;
  return { active, href: queryHref(base, query, { sort: column, dir: next, page: undefined }) };
}

/**
 * A server-sorted column for `DataList` (#48, #49): the header is the sort link, `ariaSort` marks the
 * active column. Phones hide the header row, so the same options go in the filter sheet (`AdminFilters`).
 */
export function sortColumn(props: SortProps, option: SortOption): { header: React.ReactNode; label: string; ariaSort?: "ascending" | "descending" } {
  const { active, href } = sortTarget(props, option);
  const Icon = active ? (props.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return {
    label: option.label,
    ariaSort: active ? (props.dir === "asc" ? "ascending" : "descending") : undefined,
    header: (
      <Link href={href} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")} data-testid={`sort-${option.column}`}>
        {option.label} <Icon className={cn("h-3 w-3", !active && "opacity-40")} aria-hidden />
      </Link>
    ),
  };
}
