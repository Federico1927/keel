import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Where a column goes on a phone, where every row is a card (#49):
 * - `title`: the first line, the row's main link (tapping anywhere on the card follows it);
 * - `badge`: next to the title (status);
 * - `subtitle`: the full-width second line;
 * - `meta`: small facts on the following lines, prefixed with the column's `label`;
 * - `action`: buttons, full width at the bottom of the card;
 * - `select`: the row checkbox, before the title;
 * - `detail`: not on the card, because the detail page shows it.
 */
export type DataListMobile = "title" | "badge" | "subtitle" | "meta" | "action" | "select" | "detail";

export interface DataListColumn<R> {
  key: string;
  header: React.ReactNode;
  cell: (row: R, index: number) => React.ReactNode;
  /** Card role on phones; default `meta`. */
  mobile?: DataListMobile;
  /** Short text before a `meta` value on phones; defaults to the header when it is a string. */
  label?: string;
  /** In the table: 1 always, 2 from `lg`, 3 from `xl` (the card shows every non-`detail` column). */
  priority?: 1 | 2 | 3;
  align?: "left" | "right";
  /** Classes of the cell (table and card). */
  className?: string;
  headClassName?: string;
}

const MOBILE: Record<DataListMobile, string> = {
  select: "max-md:order-0 max-md:relative max-md:z-10",
  title: "max-md:order-1 max-md:min-w-0 max-md:flex-1 max-md:font-medium max-md:[&>a:first-child]:after:absolute max-md:[&>a:first-child]:after:inset-0",
  badge: "max-md:order-2 max-md:shrink-0",
  subtitle: "max-md:order-3 max-md:basis-full max-md:min-w-0 max-md:text-muted-foreground",
  meta: "max-md:order-4 max-md:text-xs max-md:before:mr-1 max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]",
  action: "max-md:order-5 max-md:basis-full max-md:pt-1",
  detail: "max-md:hidden",
};
const PRIORITY = { 1: "", 2: "md:max-lg:hidden", 3: "md:max-xl:hidden" } as const;

function cellClass<R>(c: DataListColumn<R>) {
  const role = c.mobile ?? "meta";
  return cn(
    "px-3 py-(--density-cell-y) align-middle max-md:block max-md:p-0 max-md:empty:hidden [&:has([role=checkbox])]:pr-0",
    // links and buttons outside the title stay tappable above the card's stretched link
    role !== "title" && "max-md:[&_a]:relative max-md:[&_a]:z-10 max-md:[&_button]:relative max-md:[&_button]:z-10 max-md:[&_input]:relative max-md:[&_input]:z-10",
    MOBILE[role],
    PRIORITY[c.priority ?? 1],
    c.align === "right" && "md:text-right",
    c.className,
  );
}

/**
 * One list, two layouts from the same column definitions: a table from `md` up, a card per row on
 * phones. The markup stays a table (so tests and screen readers keep rows and cells) and CSS lays
 * it out; no column is hidden on a phone unless it says `detail`. Replaces `hidden md:table-cell`.
 */
export function DataList<R>({ columns, rows, rowKey, rowProps, footer, className, caption, ...props }: {
  columns: DataListColumn<R>[];
  rows: R[];
  rowKey: (row: R, index: number) => string;
  /** Extra attributes of each row (`data-testid`, `data-status`, a highlight class). */
  rowProps?: (row: R, index: number) => React.HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string | undefined>;
  /** A totals row: cells by column key, laid out like the rows. */
  footer?: Partial<Record<string, React.ReactNode>>;
  className?: string;
  caption?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={cn("relative w-full md:overflow-x-auto", className)} {...props}>
      <table className="w-full caption-bottom text-sm max-md:block">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="max-md:hidden [&_tr]:border-b">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn("h-(--density-head-h) px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground [&:has([role=checkbox])]:pr-0", PRIORITY[c.priority ?? 1], c.align === "right" && "text-right", c.headClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-md:block [&_tr:last-child]:border-0">
          {rows.map((row, i) => {
            const extra = rowProps?.(row, i) ?? {};
            return (
              <tr key={rowKey(row, i)} {...extra} className={cn("border-b transition-colors hover:bg-muted/50 max-md:relative max-md:flex max-md:min-h-14 max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3 max-md:after:order-2 max-md:after:h-0 max-md:after:basis-full", extra.className)}>
                {columns.map((c) => (
                  <td key={c.key} className={cellClass(c)} data-label={(c.mobile ?? "meta") === "meta" ? (c.label ?? (typeof c.header === "string" ? c.header : undefined)) : undefined}>
                    {c.cell(row, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && (
          <tfoot className="border-t bg-muted/40 font-medium max-md:block">
            <tr className="max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3">
              {columns.map((c) => (
                <td key={c.key} className={cn(cellClass(c), footer[c.key] === undefined && "max-md:hidden")} data-label={(c.mobile ?? "meta") === "meta" ? (c.label ?? (typeof c.header === "string" ? c.header : undefined)) : undefined}>
                  {footer[c.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
