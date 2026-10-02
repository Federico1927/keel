/* Recorded-shape payloads of the three subscription apps (fields trimmed to what Hullwise reads; ids and people invented). */

export const SHOPIFY_CONTRACT = {
  id: "gid://shopify/SubscriptionContract/5550001",
  status: "ACTIVE",
  createdAt: "2026-03-04T10:15:00Z",
  updatedAt: "2026-09-04T10:16:02Z",
  nextBillingDate: "2026-10-04T10:15:00Z",
  currencyCode: "USD",
  lastPaymentStatus: "SUCCEEDED",
  customer: { id: "gid://shopify/Customer/7001", email: "ava.miller@example.com", firstName: "Ava", lastName: "Miller", phone: null },
  customerPaymentMethod: { id: "gid://shopify/CustomerPaymentMethod/pm_1" },
  billingPolicy: { interval: "MONTH", intervalCount: 1 },
  deliveryPrice: { amount: "0.0" },
  originOrder: { id: "gid://shopify/Order/9100001" },
  lines: { nodes: [{ id: "gid://shopify/SubscriptionLine/61001", quantity: 2, variantId: "gid://shopify/ProductVariant/4401", productId: "gid://shopify/Product/3301", sku: "REF-CND-SEA", title: "Candle Refill", variantTitle: "Sea Salt", currentPrice: { amount: "16.0" }, lineDiscountedPrice: { amount: "28.80" } }] },
  discounts: { nodes: [{ id: "gid://shopify/SubscriptionManualDiscount/d1", title: "Subscribe & save 10%" }] },
  billingAttempts: { nodes: [
    { id: "gid://shopify/SubscriptionBillingAttempt/71003", createdAt: "2026-09-04T10:15:00Z", completedAt: "2026-09-04T10:15:40Z", ready: true, errorCode: null, errorMessage: null, originTime: "2026-09-04T10:15:00Z", order: { id: "gid://shopify/Order/9100007" } },
    { id: "gid://shopify/SubscriptionBillingAttempt/71002", createdAt: "2026-08-07T10:15:00Z", completedAt: "2026-08-07T10:15:12Z", ready: true, errorCode: null, errorMessage: null, originTime: "2026-08-04T10:15:00Z", order: { id: "gid://shopify/Order/9100005" } },
    { id: "gid://shopify/SubscriptionBillingAttempt/71001", createdAt: "2026-08-04T10:15:00Z", completedAt: "2026-08-04T10:15:09Z", ready: true, errorCode: "INSUFFICIENT_FUNDS", errorMessage: "Insufficient funds", originTime: "2026-08-04T10:15:00Z", order: null },
  ] },
};

export const SHOPIFY_CANCELLED_CONTRACT = { ...SHOPIFY_CONTRACT, id: "gid://shopify/SubscriptionContract/5550002", status: "CANCELLED", lastPaymentStatus: "FAILED", updatedAt: "2026-07-01T08:00:00Z", nextBillingDate: "2026-07-04T10:15:00Z", billingAttempts: { nodes: [] } };

export const shopifyContractsPage = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { subscriptionContracts: { nodes, pageInfo: { hasNextPage, endCursor } } } });

export const SHOPIFY_SCOPES = { data: { shop: { name: "Harbor Home", id: "gid://shopify/Shop/1" }, currentAppInstallation: { accessScopes: [{ handle: "read_own_subscription_contracts" }, { handle: "write_own_subscription_contracts" }, { handle: "read_orders" }] } } };

export const RECHARGE_SUBSCRIPTIONS = {
  subscriptions: [
    { id: 880001, customer_id: 66001, address_id: 1, status: "active", created_at: "2026-02-10T09:00:00", updated_at: "2026-09-10T09:00:05", cancelled_at: null, cancellation_reason: null, cancellation_reason_comments: null, next_charge_scheduled_at: "2026-10-10", order_interval_frequency: 1, order_interval_unit: "month", charge_interval_frequency: 1, price: "24.00", quantity: 1, external_variant_id: { ecommerce: "4402" }, external_product_id: { ecommerce: "3302" }, sku: "REF-CLN-CIT", product_title: "Cleaning Concentrate Refill", variant_title: "Citrus", presentment_currency: "USD" },
    { id: 880002, customer_id: 66002, address_id: 2, status: "cancelled", created_at: "2026-01-05T09:00:00", updated_at: "2026-06-02T12:00:00", cancelled_at: "2026-06-02T12:00:00", cancellation_reason: "I have too much product", cancellation_reason_comments: "piling up", next_charge_scheduled_at: null, order_interval_frequency: 2, order_interval_unit: "month", charge_interval_frequency: 2, price: "30.00", quantity: 2, external_variant_id: { ecommerce: "4401" }, external_product_id: { ecommerce: "3301" }, sku: "REF-CND-SEA", product_title: "Candle Refill", variant_title: "Sea Salt", presentment_currency: "USD" },
  ],
  next_cursor: "eyJwYWdlIjoyfQ",
  previous_cursor: null,
};
export const RECHARGE_CUSTOMERS = { customers: [{ id: 66001, email: "liam.jones@example.com", first_name: "Liam", last_name: "Jones", phone: null, external_customer_id: { ecommerce: "7002" } }, { id: 66002, email: "mia.davis@example.com", first_name: "Mia", last_name: "Davis", phone: "+12025550147", external_customer_id: { ecommerce: "7003" } }] };
export const RECHARGE_CHARGES = {
  charges: [
    { id: 990001, status: "error", error_type: "CLOSED_MAX_RETRIES_REACHED", error: "Card expired", scheduled_at: "2026-09-10", processed_at: null, updated_at: "2026-09-10T09:01:00", total_price: "24.00", currency: "USD", external_order_id: { ecommerce: null }, retry_date: "2026-09-13T09:00:00", line_items: [{ purchase_item_id: 880001 }] },
    { id: 990002, status: "success", error_type: null, error: null, scheduled_at: "2026-09-10", processed_at: "2026-09-13T09:00:30", updated_at: "2026-09-13T09:00:30", total_price: "24.00", currency: "USD", external_order_id: { ecommerce: "9200011" }, retry_date: null, line_items: [{ purchase_item_id: 880001 }] },
    { id: 990003, status: "queued", scheduled_at: "2026-10-10", total_price: "24.00", currency: "USD", line_items: [{ purchase_item_id: 880001 }] },
  ],
  next_cursor: null,
};

export const LOOP_SUBSCRIPTIONS = {
  success: true,
  data: [
    { id: 41001, shopifyId: 5560001, status: "PAUSED", createdAt: 1775000000, updatedAt: 1788000000, pausedAt: 1788000000, cancelledAt: null, cancellationReason: null, nextBillingDateEpoch: 1791000000, currencyCode: "USD", deliveryPrice: "4.95", billingPolicy: { interval: "WEEK", intervalCount: 4 }, customer: { shopifyId: 7004, email: "noah.wilson@example.com", firstName: "Noah", lastName: "Wilson", phone: null }, lines: [{ id: 51, variantShopifyId: 4403, productShopifyId: 3302, sku: "REF-CLN-LAV", name: "Cleaning Concentrate Refill", variantTitle: "Lavender", quantity: 3, price: "8.00" }], discounts: [{ code: "LOOP10", title: "Loop 10%", amount: "2.40" }], originOrderShopifyId: 9300001 },
  ],
};
export const LOOP_ORDERS = { success: true, data: [{ id: 61001, subscriptionId: 41001, status: "FAILED", errorCode: "card_declined", errorMessage: "Do not honor", shopifyOrderId: null, totalPrice: "28.95", currencyCode: "USD", billingDateEpoch: 1786000000, nextRetryDateEpoch: 1786259200, createdAt: 1786000100 }] };
