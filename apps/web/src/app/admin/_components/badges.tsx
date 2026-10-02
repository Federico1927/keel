import { Badge } from "@hullwise/ui";

type Variant = "success" | "warning" | "destructive" | "muted" | "info";

const LIFECYCLE: Record<string, Variant> = { trial: "info", active: "success", past_due: "warning", suspended: "destructive", churned: "muted" };
const PAYMENT: Record<string, Variant> = { ok: "success", past_due: "warning", suspended: "destructive", none: "muted" };

export function LifecycleBadge({ status, label }: { status: string; label: string }) {
  return <Badge variant={LIFECYCLE[status] ?? "muted"} data-testid="lifecycle-status" data-status={status}>{label}</Badge>;
}

export function PaymentBadge({ health, label }: { health: string; label: string }) {
  return <Badge variant={PAYMENT[health] ?? "muted"}>{label}</Badge>;
}

/** Health score 0–100 (#48): green from 85, amber from the attention threshold, red below it. */
export function HealthBadge({ score, attention, title }: { score: number; attention: boolean; title?: string }) {
  return <Badge variant={attention ? "destructive" : score < 85 ? "warning" : "success"} title={title} className="tabular" data-testid="health-score">{score}</Badge>;
}
