/** Badge colour of a webhook delivery status (#81). */
export const DELIVERY_STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "info"> = { pending: "info", sending: "info", retrying: "warning", succeeded: "success", dead: "destructive", cancelled: "muted" };
