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
  /** `aria-sort` of the header when the list is sorted by this column. */
  ariaSort?: "ascending" | "descending";
}

/** Card roles and table priorities: component classes in ../data-list.css (short, so long lists stay light). */
const MOBILE: Record<DataListMobile, string> = { select: "dl-select", title: "dl-title", badge: "dl-badge", subtitle: "dl-subtitle", meta: "dl-meta", action: "dl-action", detail: "dl-detail" };
const PRIORITY = { 1: "", 2: "dl-p2", 3: "dl-p3" } as const;

function cellClass<R>(c: DataListColumn<R>) {
  const role = c.mobile ?? "meta";
  return cn("dl-cell", role !== "title" && "dl-touch", MOBILE[role], PRIORITY[c.priority ?? 1], c.align === "right" && "dl-right", c.className);
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
              <th key={c.key} aria-sort={c.ariaSort} className={cn("dl-head", PRIORITY[c.priority ?? 1], c.align === "right" && "text-right", c.headClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-md:block [&_tr:last-child]:border-0">
          {rows.map((row, i) => {
            const extra = rowProps?.(row, i) ?? {};
            return (
              <tr key={rowKey(row, i)} {...extra} className={cn("dl-row", extra.className)}>
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
            <tr className="dl-foot-row">
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
