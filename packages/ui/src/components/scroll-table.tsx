"use client";
import * as React from "react";
import { cn } from "../lib/cn";

/**
 * A wide analysis table (P/L by period, planning grids, cohorts) that keeps its columns on a phone
 * and scrolls sideways inside its own region, never the page (#49, Tier 3). The region is marked:
 * focusable with a label (`role="region"`, keyboard scroll), a "scroll →" hint and edge shadows while
 * there is more to see, and optionally a sticky first column. Lists use `DataList` instead.
 */
export function ScrollTable({ label, hint, stickyFirst, className, wrapperClassName, children, ...props }: {
  /** Accessible name of the scroll region (the table's title). */
  label: string;
  /** Short visible text shown, followed by an arrow, while the table overflows. */
  hint?: string;
  /** Keep the first column in view while scrolling. */
  stickyFirst?: boolean;
  wrapperClassName?: string;
} & React.TableHTMLAttributes<HTMLTableElement>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edge, setEdge] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setEdge((e) => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      return e.left === left && e.right === right ? e : { left, right };
    });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  const overflowing = edge.left || edge.right;
  return (
    <div className={cn("relative min-w-0", wrapperClassName)} data-scroll-table="" data-overflowing={overflowing ? "true" : "false"}>
      {hint && overflowing && (
        <p aria-hidden className="flex justify-end px-3 pb-1 pt-1 text-[11px] font-medium text-muted-foreground" data-testid="scroll-hint">
          {hint} <span className={cn("ml-1 transition-opacity", !edge.right && "opacity-30")}>→</span>
        </p>
      )}
      <div className="relative">
        <div ref={ref} role="region" aria-label={label} tabIndex={0} className="overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-testid="scroll-region">
          <table
            className={cn(
              "w-full caption-bottom text-sm [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap [&_td:first-child]:whitespace-normal",
              stickyFirst && "[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_tr>*:first-child]:bg-card",
              stickyFirst && edge.left && "[&_tr>*:first-child]:shadow-[6px_0_6px_-6px_color-mix(in_srgb,var(--fg)_35%,transparent)]",
              className,
            )}
            {...props}
          >
            {children}
          </table>
        </div>
        <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-5 bg-linear-to-r from-foreground/12 to-transparent transition-opacity", edge.left && !stickyFirst ? "opacity-100" : "opacity-0")} />
        <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-0 w-5 bg-linear-to-l from-foreground/12 to-transparent transition-opacity", edge.right ? "opacity-100" : "opacity-0")} />
      </div>
    </div>
  );
}
