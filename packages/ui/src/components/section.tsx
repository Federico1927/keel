import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * A titled card section that folds on phones (native `<details>`, open by default) and is a plain
 * card from `md` up, where the summary does not toggle.
 */
export function Section({ title, actions, defaultOpen = true, children, className, contentClassName, ...props }: { title: React.ReactNode; actions?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode; className?: string; contentClassName?: string } & Omit<React.HTMLAttributes<HTMLDetailsElement>, "title">) {
  return (
    <details open={defaultOpen} className={cn("group rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-(--density-card) pb-3 md:pointer-events-none [&::-webkit-details-marker]:hidden">
        <h2 className="text-base font-semibold leading-none tracking-tight">{title}</h2>
        <span className="flex items-center gap-2">
          {actions && <span className="md:pointer-events-auto">{actions}</span>}
          <ChevronDown aria-hidden className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 md:hidden" />
        </span>
      </summary>
      <div className={cn("px-(--density-card) pb-(--density-card)", contentClassName)}>{children}</div>
    </details>
  );
}
