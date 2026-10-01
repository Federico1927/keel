import { cn } from "@keel/ui";

/** Product mark (the keel): drawn with the primary token, so it follows the theme and the tenant's brand colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("h-7 w-7 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <g fill="none" stroke="var(--on-primary)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 11.5c0 8.5 4.6 14 9.5 14s9.5-5.5 9.5-14" />
        <path d="M16 7v18.5" />
        <path d="M6.5 11.5h19" />
      </g>
    </svg>
  );
}
