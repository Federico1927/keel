import { Badge } from "@hullwise/ui";

const VARIANT: Record<string, "outline" | "muted" | "success" | "warning" | "info"> = { draft: "outline", pending_approval: "warning", approved: "info", scheduled: "info", sending: "warning", sent: "success", active: "success", paused: "muted" };

/** Campaign status chip: waiting states stand out, finished ones are green. */
export function CampaignStatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge variant={VARIANT[status] ?? "outline"} data-testid="campaign-status">{label}</Badge>;
}
