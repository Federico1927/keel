import * as React from "react";
import { cn } from "../lib/cn";

export type ControlSize = "sm" | "default";

/** Height, horizontal padding and a line height equal to the inner height (border excluded), per size. */
export const controlSize: Record<ControlSize, string> = {
  sm: "h-8 px-2.5 leading-[1.875rem]",
  default: "h-10 px-3 leading-[2.375rem]",
};

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** Height step shared with `Select`: `sm` for filter bars and tables, `default` for forms. */
  size?: ControlSize;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, size = "default", ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex w-full rounded-md border border-input bg-card py-0 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      type === "file" ? "h-auto py-1.5 px-3" : controlSize[size],
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";
