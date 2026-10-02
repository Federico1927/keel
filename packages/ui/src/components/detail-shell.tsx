import * as React from "react";
import { cn } from "../lib/cn";

/** Record page template: back link, eyebrow, title, chips, one primary action, actions menu. */
export function DetailShell({ back, eyebrow, title, chips, actions, aside, children, className }: { back?: React.ReactNode; eyebrow?: string; title: React.ReactNode; chips?: React.ReactNode; actions?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-6", className)}>
      {back && <div className="text-sm text-muted-foreground">{back}</div>}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{eyebrow}</p>}
          <h1 className="truncate text-2xl sm:text-3xl">{title}</h1>
          {chips && <div className="mt-2 flex flex-wrap items-center gap-2">{chips}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-6", aside && "lg:grid-cols-[minmax(0,1fr)_22rem]")}>
        <div className="min-w-0 space-y-6">{children}</div>
        {aside && <div className="space-y-6">{aside}</div>}
      </div>
    </div>
  );
}
