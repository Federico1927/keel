export class ReturnError extends Error {
  constructor(public readonly code: "order_not_found" | "return_not_found" | "not_eligible" | "no_lines" | "quantity_exceeds" | "bad_transition" | "bad_reason" | "location_required" | "invalid_input" | "customer_limit" | "line_blocked") {
    super(code);
  }
}
