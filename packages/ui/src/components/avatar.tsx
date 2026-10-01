import * as React from "react";
import { cn } from "../lib/cn";

const sizes = { sm: "h-7 w-7 text-[11px]", md: "h-9 w-9 text-xs", lg: "h-16 w-16 text-lg" } as const;

/** Round profile picture, or the person's initials on a tinted disc when there is no photo. */
export function Avatar({ src, initials, alt = "", size = "sm", className }: { src?: string | null; initials: string; alt?: string; size?: keyof typeof sizes; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/12 font-semibold text-foreground ring-1 ring-border", sizes[size], className)} aria-hidden={alt ? undefined : true}>
      {src ? <img src={src} alt={alt} className="h-full w-full object-cover" /> : initials}
    </span>
  );
}
