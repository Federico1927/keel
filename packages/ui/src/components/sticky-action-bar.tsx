import * as React from "react";
import { cn } from "../lib/cn";

/**
 * The primary action of a detail page (#49): inline where it is placed from `md` up; on phones it
 * docks at the bottom of the screen, above the bottom navigation, within thumb reach. Render it
 * once; the page keeps room for it with `<StickyActionSpacer />` at the end of its content.
 */
export function StickyActionBar({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        "max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(var(--bottom-nav-h,0px)+env(safe-area-inset-bottom))] max-md:z-30 max-md:border-t max-md:bg-card/95 max-md:px-4 max-md:py-2.5 max-md:shadow-[0_-4px_12px_-6px_hsl(var(--shadow-color)/0.2)] max-md:backdrop-blur max-md:[&>*]:min-w-0",
        className,
      )}
      data-sticky-actions
      {...props}
    >
      {children}
    </div>
  );
}

export function StickyActionSpacer() {
  return <div aria-hidden className="h-20 md:hidden" />;
}
