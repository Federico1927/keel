import * as React from "react";
import { cn } from "../lib/cn";

export function Stat({ label, value, hint, trend, className, href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; trend?: { value: number; label?: string } | null; className?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</p>
      {(hint || trend) && (
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {trend && (
            <span className={cn("font-medium tabular", trend.value > 0 ? "text-success" : trend.value < 0 ? "text-destructive" : "")}>
              {trend.value > 0 ? "+" : ""}
              {(trend.value * 100).toFixed(1)}%
            </span>
          )}
          {hint}
        </p>
      )}
    </>
  );
  const cls = cn("block rounded-lg border bg-card p-(--density-stat) shadow-sm", href && "transition-colors hover:bg-muted/40", className);
  return href ? (
    <a href={href} className={cls}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}
