import { Badge } from "@hullwise/ui";

/** Stripe TEST / LIVE (from the key prefix) or mock; the key itself is never shown (#53). */
export function BillingModeBadge({ mode, label }: { mode: "mock" | "test" | "live"; label: string }) {
  return <Badge variant={mode === "live" ? "success" : mode === "test" ? "warning" : "muted"} className="font-mono uppercase tracking-wide" data-testid="billing-mode" data-mode={mode}>{label}</Badge>;
}
