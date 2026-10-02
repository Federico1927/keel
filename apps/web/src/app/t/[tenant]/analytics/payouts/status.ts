/** Badge colour per payout status. */
export const PAYOUT_STATUS_VARIANT: Record<string, "success" | "info" | "warning" | "destructive" | "muted"> = { paid: "success", in_transit: "info", scheduled: "muted", failed: "destructive", canceled: "warning" };
