import * as React from "react";
import { cn } from "../lib/cn";

export type ControlSize = "sm" | "default";

/** Height, horizontal padding and a line height equal to the inner height (border excluded), per size. */
export const controlSize: Record<ControlSize, string> = {
  sm: "h-8 px-2.5 leading-[1.875rem] pointer-coarse:h-11 pointer-coarse:leading-[2.625rem]",
  default: "h-10 px-3 leading-[2.375rem] pointer-coarse:h-11 pointer-coarse:leading-[2.625rem]",
};

/** The phone keyboard that fits a number field: decimals when the step allows them. */
export function numberInputMode(step: React.InputHTMLAttributes<HTMLInputElement>["step"]): "numeric" | "decimal" {
  return step !== undefined && step !== "any" && Number.isInteger(Number(step)) ? "numeric" : step === undefined ? "numeric" : "decimal";
}

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** Height step shared with `Select`: `sm` for filter bars and tables, `default` for forms. */
  size?: ControlSize;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, size = "default", inputMode, ...props }, ref) => (
  <input
    type={type}
    inputMode={inputMode ?? (type === "number" ? numberInputMode(props.step) : undefined)}
    className={cn(
      // 16px text on touch screens: iOS zooms into any smaller field on focus
      "flex w-full rounded-md border border-input bg-card py-0 text-sm shadow-sm pointer-coarse:text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      type === "file" ? "h-auto py-1.5 px-3" : controlSize[size],
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";
