"use client";
import * as React from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";

/**
 * Filters of a list (#49): inline from `md` up; on phones a "Filters (n)" button opens them as a
 * bottom sheet. The controls are rendered once (no duplicate ids) and only their container changes.
 * `chips` (active filters, removable) stay visible on every width.
 */
export function FilterPanel({ label, title, doneLabel, doneForm, closeLabel, activeCount = 0, chips, aside, children, className }: {
  /** Text of the phone button ("Filters"). */
  label: string;
  /** Sheet heading; defaults to `label`. */
  title?: string;
  /** Button that closes the sheet ("Show results"). */
  doneLabel: string;
  /** Id of a form inside the panel that "Show results" submits (a server-side GET form: the page reloads); otherwise it closes the sheet. */
  doneForm?: string;
  closeLabel: string;
  activeCount?: number;
  chips?: React.ReactNode;
  /** Shown next to the phone button (sort, a search field). */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2 md:hidden">
        <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => setOpen(true)} aria-expanded={open} data-testid="filters-open">
          <SlidersHorizontal /> {label}
          {activeCount > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium leading-5 text-primary-foreground tabular" data-testid="filters-count">{activeCount}</span>}
        </Button>
        {aside && <div className="min-w-0 flex-1">{aside}</div>}
      </div>
      {chips && <div className="flex flex-wrap gap-2">{chips}</div>}
      {open && <div className="fixed inset-0 z-40 bg-overlay md:hidden" aria-hidden onClick={() => setOpen(false)} />}
      <div
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? (title ?? label) : undefined}
        className={cn(
          "md:block",
          open ? "max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-50 max-md:max-h-[85dvh] max-md:overflow-y-auto max-md:rounded-t-2xl max-md:border max-md:bg-card max-md:p-4 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:shadow-lg" : "max-md:hidden",
        )}
        data-testid="filters-panel"
      >
        {open && (
          <div className="mb-3 flex items-center justify-between md:hidden">
            <p className="text-base font-semibold">{title ?? label}</p>
            <Button type="button" variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label={closeLabel}><X /></Button>
          </div>
        )}
        {children}
        {open && (
          <Button type={doneForm ? "submit" : "button"} form={doneForm} className="mt-4 w-full md:hidden" onClick={doneForm ? undefined : () => setOpen(false)} data-testid="filters-done">{doneLabel}</Button>
        )}
      </div>
    </div>
  );
}

/** One active filter, removable. */
export function FilterChip({ children, onRemove, removeLabel, className, ...props }: { children: React.ReactNode; onRemove: () => void; removeLabel: string; className?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  return (
    <button type="button" onClick={onRemove} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs pointer-coarse:min-h-9", className)} {...props}>
      <span className="truncate">{children}</span> <X className="h-3 w-3 shrink-0" aria-hidden /><span className="sr-only">{removeLabel}</span>
    </button>
  );
}
