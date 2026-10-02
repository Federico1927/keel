import * as React from "react";
import { cn } from "../lib/cn";
import { StickyActionBar, StickyActionSpacer } from "./sticky-action-bar";

/**
 * Record page template: back link, eyebrow, title, chips (status), key numbers, secondary actions
 * and the primary action. From `md` up the primary action sits after the other actions in the
 * header; on phones it docks at the bottom of the screen (#49). The aside stacks under the main
 * column below `lg`.
 */
export function DetailShell({ back, eyebrow, title, chips, stats, actions, primaryActions, aside, children, className }: { back?: React.ReactNode; eyebrow?: string; title: React.ReactNode; chips?: React.ReactNode; /** Key numbers under the title. */ stats?: React.ReactNode; actions?: React.ReactNode; primaryActions?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-6", className)}>
      {back && <div className="text-sm text-muted-foreground">{back}</div>}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{eyebrow}</p>}
          <h1 className="truncate text-2xl sm:text-3xl">{title}</h1>
          {chips && <div className="mt-2 flex flex-wrap items-center gap-2">{chips}</div>}
          {stats && <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">{stats}</div>}
        </div>
        {(actions || primaryActions) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {primaryActions && <StickyActionBar className="md:contents">{primaryActions}</StickyActionBar>}
          </div>
        )}
      </div>
      <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-6", aside && "lg:grid-cols-[minmax(0,1fr)_22rem]")}>
        <div className="min-w-0 space-y-6">{children}</div>
        {aside && <div className="min-w-0 space-y-6">{aside}</div>}
      </div>
      {primaryActions && <StickyActionSpacer />}
    </div>
  );
}

/** One key number of a detail header: label over value. */
export function DetailStat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold tabular">{value}</p>
    </div>
  );
}
