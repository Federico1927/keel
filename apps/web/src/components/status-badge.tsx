"use client";
import { useTranslations } from "next-intl";
import { Badge } from "@keel/ui";

const VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive" | "info" | "muted" | "outline"> = {
  new: "info",
  pending_review: "warning",
  confirmed: "default",
  fulfilling: "default",
  shipped: "secondary",
  delivered: "success",
  on_hold: "warning",
  cancelled: "destructive",
  returned_partial: "warning",
  returned: "destructive",
  refunded: "muted",
  // payment
  pending: "warning",
  paid: "success",
  partially_refunded: "warning",
  voided: "muted",
  // shipments
  label_created: "secondary",
  in_transit: "info",
  out_for_delivery: "info",
  attempted: "warning",
  exception: "destructive",
  failed: "destructive",
  unknown: "muted",
};

export function StatusBadge({ status, namespace = "order_status", className }: { status: string; namespace?: "order_status" | "payment_status" | "shipment_status" | "return_status" | "po_status"; className?: string }) {
  const t = useTranslations(namespace);
  return (
    <Badge variant={VARIANT[status] ?? "outline"} className={className}>
      {t.has(status) ? t(status) : status}
    </Badge>
  );
}
