import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { controlSize, type ControlSize } from "./input";

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  /** Height step shared with `Input`: `sm` for filter bars and tables, `default` for forms. */
  size?: ControlSize;
  /** Classes for the positioning wrapper (grid placement, width in flex rows). */
  wrapperClassName?: string;
};

/**
 * Native select styled like the inputs: reliable in forms and server actions. The height alone sets
 * its size: no vertical padding and a line height equal to the inner height, so the text is centred
 * and never clipped (WebKit draws native select text from the top of the padding box).
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, wrapperClassName, children, size = "default", multiple, ...props }, ref) => (
  <div className={cn("relative", wrapperClassName)}>
    <select
      ref={ref}
      multiple={multiple}
      className={cn(
        "flex w-full appearance-none rounded-md border border-input bg-card text-sm shadow-sm pointer-coarse:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        multiple ? "min-h-24 px-3 py-2" : cn(controlSize[size], "py-0 pr-8"),
        className,
      )}
      {...props}
    >
      {children}
    </select>
    {!multiple && <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
  </div>
));
Select.displayName = "Select";
