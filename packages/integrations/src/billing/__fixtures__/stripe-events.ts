/**
 * Webhook payloads in the shape Stripe sends (trimmed to the fields Hullwise reads, ids anonymised).
 * `legacy*` use the pre-2025 layout (periods on the subscription, `invoice.subscription`,
 * `line.price`); the others the 2025-03-31 "basil" layout. Test-mode values only, no secrets.
 */
export const LEGACY_SUBSCRIPTION_UPDATED = {
  id: "evt_1QlegacySubUpdated",
  object: "event",
  api_version: "2024-06-20",
  created: 1790000000,
  livemode: false,
  type: "customer.subscription.updated",
  data: {
    object: {
      id: "sub_1QlegacyA",
      object: "subscription",
      customer: "cus_QlegacyA",
      status: "past_due",
      collection_method: "charge_automatically",
      current_period_start: 1789000000,
      current_period_end: 1791600000,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      cancellation_details: { reason: null },
      latest_invoice: "in_1QlegacyA",
      default_payment_method: "pm_1QlegacyA",
      metadata: { hullwise_tenant_id: "00000000-0000-4000-8000-00000000000a" },
      items: { object: "list", data: [{ id: "si_QlegacyA", object: "subscription_item", quantity: 1, price: { id: "price_1QlegacyPlan", object: "price", currency: "usd", lookup_key: "hullwise_plan_growth_monthly", unit_amount: 59900, recurring: { interval: "month", interval_count: 1 } } }] },
    },
  },
};

export const LEGACY_INVOICE_PAYMENT_FAILED = {
  id: "evt_1QlegacyInvFailed",
  object: "event",
  api_version: "2024-06-20",
  created: 1790000100,
  livemode: false,
  type: "invoice.payment_failed",
  data: {
    object: {
      id: "in_1QlegacyA",
      object: "invoice",
      number: "ABCD1234-0002",
      customer: "cus_QlegacyA",
      subscription: "sub_1QlegacyA",
      subscription_details: { metadata: { hullwise_tenant_id: "00000000-0000-4000-8000-00000000000a" } },
      status: "open",
      collection_method: "charge_automatically",
      billing_reason: "subscription_cycle",
      currency: "usd",
      subtotal: 59900,
      tax: 13178,
      total: 73078,
      attempt_count: 1,
      next_payment_attempt: 1790259300,
      created: 1790000000,
      due_date: null,
      period_start: 1789000000,
      period_end: 1791600000,
      hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/test_legacy",
      invoice_pdf: "https://pay.stripe.com/invoice/acct_test/test_legacy/pdf",
      status_transitions: { finalized_at: 1790000050, paid_at: null },
      metadata: {},
      lines: { object: "list", data: [{ id: "il_1", amount: 59900, description: "1 × Hullwise Growth (at $599.00 / month)", proration: false, price: { id: "price_1QlegacyPlan", lookup_key: "hullwise_plan_growth_monthly" } }] },
    },
  },
};

export const CHECKOUT_COMPLETED = {
  id: "evt_1QcheckoutDone",
  object: "event",
  api_version: "2025-03-31.basil",
  created: 1790000200,
  livemode: false,
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_a1", object: "checkout.session", mode: "subscription", customer: "cus_QnewB", subscription: "sub_1QnewB", client_reference_id: "00000000-0000-4000-8000-00000000000b", status: "complete", payment_status: "paid", metadata: { hullwise_tenant_id: "00000000-0000-4000-8000-00000000000b" } } },
};

export const CUSTOMER_UPDATED = {
  id: "evt_1QcustomerUpd",
  object: "event",
  api_version: "2025-03-31.basil",
  created: 1790000300,
  livemode: false,
  type: "customer.updated",
  data: { object: { id: "cus_QnewB", object: "customer", email: "billing@example.com", name: "Example GmbH", address: { country: "DE" }, tax_exempt: "none", metadata: { hullwise_tenant_id: "00000000-0000-4000-8000-00000000000b" }, tax_ids: { object: "list", data: [{ id: "txi_1", type: "eu_vat", value: "DE123456789", verification: { status: "verified" } }] } } },
};
