import { ImageOff } from "lucide-react";
import { cn } from "@keel/ui";

/** Product or variant thumbnail for lists (issue #19); a neutral tile when there is no image. */
export function ProductThumb({ src, alt, size = "sm", className }: { src: string | null | undefined; alt: string; size?: "xs" | "sm" | "md"; className?: string }) {
  const box = size === "xs" ? "h-7 w-7" : size === "md" ? "h-14 w-14" : "h-10 w-10";
  if (!src) return <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground", box, className)} aria-hidden><ImageOff className="h-3.5 w-3.5" /></span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("shrink-0 rounded-md border bg-muted object-cover", box, className)} />;
}
