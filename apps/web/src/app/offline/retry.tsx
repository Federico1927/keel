"use client";
import { Button } from "@hullwise/ui";

export function RetryButton({ label }: { label: string }) {
  return <Button onClick={() => window.history.length > 1 ? window.history.back() : window.location.assign("/")}>{label}</Button>;
}
