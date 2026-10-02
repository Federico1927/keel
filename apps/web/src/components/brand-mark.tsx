import { cn } from "@hullwise/ui";

/** Product mark (a hull on its waterline): drawn with the primary token, so it follows the theme and the tenant's brand colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("h-7 w-7 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <g fill="none" stroke="var(--on-primary)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.5 15.5h21l-2.7 5.2a3 3 0 0 1-2.66 1.6H10.86a3 3 0 0 1-2.66-1.6z" />
        <path d="M15 5.5v10" />
        <path d="M15 6.5l7 7.5h-7z" />
        <path d="M6 26.3c2.5 0 2.5-1.5 5-1.5s2.5 1.5 5 1.5 2.5-1.5 5-1.5 2.5 1.5 5 1.5" />
      </g>
    </svg>
  );
}
