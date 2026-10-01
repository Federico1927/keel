/** Recorded-shape payloads (anonymised, trimmed) used by the adapter tests. No network. */
export const restOrderWebhook = {
  id: 5678901234567,
  name: "#NW1042",
  order_number: 1042,
  email: "giulia.rossi@example.com",
  phone: null,
  currency: "EUR",
  created_at: "2026-09-28T10:15:00+02:00",
  updated_at: "2026-09-29T08:00:00+02:00",
  processed_at: "2026-09-28T10:15:02+02:00",
  cancelled_at: null,
  cancel_reason: null,
  closed_at: null,
  financial_status: "paid",
  fulfillment_status: "partial",
  tags: "vip, wholesale",
  note: "Lasciare al portiere",
  note_attributes: [{ name: "utm_campaign", value: "120210000000001" }, { name: "utm_source", value: "facebook" }],
  landing_site: "/products/giacca?utm_source=facebook&utm_medium=paid&utm_campaign=120210000000001&fbclid=IwAR123",
  referring_site: "https://l.facebook.com/",
  source_name: "web",
  subtotal_price: "189.00",
  total_discounts: "18.90",
  total_tax: "30.68",
  total_price: "176.00",
  payment_gateway_names: ["shopify_payments"],
  shipping_lines: [{ price: "5.90", title: "Standard" }],
  discount_codes: [{ code: "WELCOME10", amount: "18.90", type: "percentage" }],
  customer: { id: 7000000001, email: "giulia.rossi@example.com", first_name: "Giulia", last_name: "Rossi", phone: "+39 333 1234567", tags: "", created_at: "2025-03-01T09:00:00+01:00", email_marketing_consent: { state: "subscribed" }, default_address: { city: "Milano", zip: "20121", country_code: "IT", phone: "+39 333 1234567" } },
  shipping_address: { first_name: "Giulia", last_name: "Rossi", address1: "Via Roma 1", city: "Milano", zip: "20121", province_code: "MI", country_code: "IT", phone: "+39 333 1234567" },
  billing_address: null,
  line_items: [
    { id: 1001, variant_id: 4100001, product_id: 8100001, sku: "GIA-M-BLU", title: "Giacca Primavera", variant_title: "M / Blu", quantity: 1, current_quantity: 1, price: "129.00", discount_allocations: [{ amount: "12.90" }] },
    { id: 1002, variant_id: 4100002, product_id: 8100002, sku: "TSH-L-BIA", title: "T-shirt Basic", variant_title: "L / Bianco", quantity: 2, current_quantity: 2, price: "30.00", discount_allocations: [{ amount: "6.00" }] },
  ],
  fulfillments: [{ id: 9001, status: "success", shipment_status: "in_transit", tracking_number: "BRT123456789IT", tracking_url: "https://track.example/BRT123456789IT", tracking_company: "BRT", created_at: "2026-09-29T07:00:00+02:00", updated_at: "2026-09-29T08:00:00+02:00" }],
  refunds: [],
};

export const graphqlOrdersPage = {
  data: {
    orders: {
      nodes: [
        {
          id: "gid://shopify/Order/5678901234568",
          legacyResourceId: "5678901234568",
          name: "#NW1043",
          email: "marco.bianchi@example.com",
          phone: null,
          note: null,
          tags: [],
          createdAt: "2026-09-28T11:00:00Z",
          updatedAt: "2026-09-28T11:05:00Z",
          cancelledAt: null,
          cancelReason: null,
          closedAt: null,
          processedAt: "2026-09-28T11:00:01Z",
          currencyCode: "EUR",
          displayFinancialStatus: "PENDING",
          displayFulfillmentStatus: "UNFULFILLED",
          paymentGatewayNames: ["Cash on Delivery (COD)"],
          sourceName: "web",
          landingPageUrl: "https://northwind.example/collections/all?gclid=Cj0abc",
          referrerUrl: "https://www.google.com/",
          customAttributes: [],
          subtotalPriceSet: { shopMoney: { amount: "59.00" } },
          totalDiscountsSet: { shopMoney: { amount: "0.00" } },
          totalShippingPriceSet: { shopMoney: { amount: "5.90" } },
          totalTaxSet: { shopMoney: { amount: "11.70" } },
          totalPriceSet: { shopMoney: { amount: "64.90" } },
          totalRefundedSet: { shopMoney: { amount: "0.00" } },
          customer: { id: "gid://shopify/Customer/7000000002", legacyResourceId: "7000000002", email: "marco.bianchi@example.com", phone: "+393471234567", firstName: "Marco", lastName: "Bianchi", tags: [], createdAt: "2026-01-10T08:00:00Z", emailMarketingConsent: { marketingState: "NOT_SUBSCRIBED" }, smsMarketingConsent: null, defaultAddress: { city: "Torino", zip: "10121", countryCodeV2: "IT", phone: "+393471234567" } },
          shippingAddress: { name: "Marco Bianchi", address1: "Corso Francia 10", address2: null, city: "Torino", provinceCode: "TO", zip: "10121", countryCodeV2: "IT", phone: "+393471234567" },
          billingAddress: null,
          discountCodes: [],
          discountApplications: { nodes: [] },
          lineItems: { nodes: [{ id: "gid://shopify/LineItem/2001", quantity: 1, currentQuantity: 1, sku: "SNK-42-NER", title: "Sneaker Urban", variantTitle: "42 / Nero", variant: { legacyResourceId: "4100003" }, product: { legacyResourceId: "8100003" }, originalUnitPriceSet: { shopMoney: { amount: "59.00" } }, totalDiscountSet: { shopMoney: { amount: "0.00" } } }] },
          fulfillments: [],
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "eyJsYXN0X2lkIjo1Njc4OTAxMjM0NTY4fQ==" },
    },
  },
  extensions: { cost: { requestedQueryCost: 52, actualQueryCost: 20, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1980, restoreRate: 100 } } },
};

export const graphqlProductsPage = {
  data: {
    products: {
      nodes: [
        {
          id: "gid://shopify/Product/8100001",
          legacyResourceId: "8100001",
          title: "Giacca Primavera",
          handle: "giacca-primavera",
          vendor: "Northwind",
          productType: "Outerwear",
          status: "ACTIVE",
          tags: ["new-in"],
          createdAt: "2026-02-01T10:00:00Z",
          options: [{ name: "Size", values: ["S", "M", "L"] }, { name: "Color", values: ["Blu"] }],
          featuredMedia: { preview: { image: { url: "https://cdn.example/giacca.jpg" } } },
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/4100001", legacyResourceId: "4100001", sku: "GIA-M-BLU", barcode: "8001234567890", title: "M / Blu", price: "129.00", compareAtPrice: "159.00", selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Blu" }], inventoryItem: { id: "gid://shopify/InventoryItem/4500001", legacyResourceId: "4500001", measurement: { weight: { value: 0.8, unit: "KILOGRAMS" } } } }] },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

export const graphqlShop = { data: { shop: { name: "Northwind Apparel", myshopifyDomain: "northwind-demo.myshopify.com", currencyCode: "EUR" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "write_orders" }, { handle: "read_products" }, { handle: "write_products" }, { handle: "read_inventory" }, { handle: "write_inventory" }, { handle: "read_customers" }, { handle: "read_discounts" }, { handle: "write_discounts" }, { handle: "read_fulfillments" }, { handle: "read_locations" }] } } };

export const graphqlThrottled = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } } } };

export const graphqlDiscounts = {
  data: {
    discountNodes: {
      nodes: [
        { id: "gid://shopify/DiscountCodeNode/1200001", discount: { __typename: "DiscountCodeBasic", title: "Welcome 10%", status: "ACTIVE", startsAt: "2026-01-01T00:00:00Z", endsAt: null, usageLimit: null, asyncUsageCount: 412, codes: { nodes: [{ code: "WELCOME10" }] }, customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 } }, minimumRequirement: null } },
        { id: "gid://shopify/DiscountCodeNode/1200002", discount: { __typename: "DiscountCodeFreeShipping", title: "Free shipping over 50", status: "ACTIVE", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-12-31T00:00:00Z", usageLimit: 1000, asyncUsageCount: 88, codes: { nodes: [{ code: "FREESHIP" }] } } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

export const graphqlInventory = { data: { nodes: [{ id: "gid://shopify/InventoryItem/4500001", legacyResourceId: "4500001", inventoryLevels: { nodes: [{ updatedAt: "2026-09-29T06:00:00Z", location: { id: "gid://shopify/Location/6100001", legacyResourceId: "6100001" }, quantities: [{ name: "available", quantity: 12 }, { name: "on_hand", quantity: 15 }, { name: "committed", quantity: 3 }] }] } }] } };

export const graphqlWebhooks = { data: { webhookSubscriptions: { nodes: [{ topic: "ORDERS_CREATE", endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: "https://keel.example/api/webhooks/shopify" } }] } } };
export const graphqlWebhookCreate = { data: { webhookSubscriptionCreate: { userErrors: [] } } };
export const graphqlCancel = { data: { orderCancel: { job: { id: "gid://shopify/Job/1" }, orderCancelUserErrors: [], userErrors: [] } } };
