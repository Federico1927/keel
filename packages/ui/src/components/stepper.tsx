"use client";
import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Quantity field with − / + buttons (44px on touch screens) and the numeric keyboard. Works
 * controlled (`value` + `onValueChange`) or inside a form (`name` + `defaultValue`).
 */
export function Stepper({ value, defaultValue = 0, onValueChange, min = 0, max, step = 1, name, id, disabled, className, decrementLabel, incrementLabel, size = "default", ...props }: {
  value?: number;
  defaultValue?: number;
  onValueChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  name?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  decrementLabel: string;
  incrementLabel: string;
  size?: "sm" | "default";
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "size" | "type" | "min" | "max" | "step">) {
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  const clamp = (n: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));
  const set = (n: number) => {
    const next = clamp(Number.isFinite(n) ? n : min);
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };
  const btn = cn("inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40", size === "sm" ? "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11" : "h-10 w-10 pointer-coarse:h-11 pointer-coarse:w-11");
  return (
    <div className={cn("inline-flex items-stretch overflow-hidden rounded-md border border-input bg-card shadow-sm", className)}>
      <button type="button" className={btn} onClick={() => set(current - step)} disabled={disabled || current <= min} aria-label={decrementLabel}><Minus className="h-4 w-4" /></button>
      <input
        type="number"
        inputMode="numeric"
        id={id}
        name={name}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Number.isFinite(current) ? current : ""}
        onChange={(e) => set(e.target.value === "" ? min : Math.trunc(Number(e.target.value)))}
        className="w-14 min-w-0 border-x border-input bg-transparent text-center text-sm tabular [appearance:textfield] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:text-base [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        {...props}
      />
      <button type="button" className={btn} onClick={() => set(current + step)} disabled={disabled || (max !== undefined && current >= max)} aria-label={incrementLabel}><Plus className="h-4 w-4" /></button>
    </div>
  );
}
