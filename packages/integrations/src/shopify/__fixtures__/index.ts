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

/** A product as the 2025-07 product query returns it (issue #19 fields + #23 unit cost). */
export const graphqlProductNode = {
  id: "gid://shopify/Product/8100001",
  legacyResourceId: "8100001",
  title: "Giacca Primavera",
  handle: "giacca-primavera",
  vendor: "Northwind",
  productType: "Outerwear",
  status: "ACTIVE",
  tags: ["new-in"],
  createdAt: "2026-02-01T10:00:00Z",
  updatedAt: "2026-09-20T08:15:00Z",
  descriptionHtml: "<p>Giacca leggera <strong>impermeabile</strong>.</p>",
  seo: { title: "Giacca Primavera impermeabile", description: "Giacca leggera per la mezza stagione." },
  category: { id: "gid://shopify/TaxonomyCategory/aa-1-10-2", name: "Coats & Jackets", fullName: "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets" },
  options: [{ name: "Size", values: ["S", "M", "L"] }, { name: "Color", values: ["Blu"] }],
  featuredMedia: { preview: { image: { url: "https://cdn.example/giacca.jpg" } } },
  media: {
    nodes: [
      { id: "gid://shopify/MediaImage/3100001", alt: "Giacca blu, fronte", mediaContentType: "IMAGE", preview: { image: { url: "https://cdn.example/giacca.jpg", width: 1200, height: 1500 } }, image: { url: "https://cdn.example/giacca.jpg", width: 1200, height: 1500 } },
      { id: "gid://shopify/Video/3100002", alt: null, mediaContentType: "VIDEO", preview: { image: { url: "https://cdn.example/giacca-video.jpg", width: 1280, height: 720 } } },
      { id: "gid://shopify/MediaImage/3100009", alt: "processing", mediaContentType: "IMAGE", preview: { image: null }, image: null },
    ],
    pageInfo: { hasNextPage: true, endCursor: "media-cursor-1" },
  },
  collections: { nodes: [{ id: "gid://shopify/Collection/501", title: "Primavera 2026", handle: "primavera-2026" }] },
  resourcePublications: { nodes: [{ isPublished: true, publishDate: "2026-02-01T10:05:00Z", publication: { id: "gid://shopify/Publication/1", name: "Online Store" } }, { isPublished: false, publishDate: null, publication: { id: "gid://shopify/Publication/2", name: "Point of Sale" } }] },
  metafields: { nodes: [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Nylon riciclato" }] },
  variants: {
    nodes: [
      { id: "gid://shopify/ProductVariant/4100001", legacyResourceId: "4100001", sku: "GIA-M-BLU", barcode: "8001234567890", title: "M / Blu", price: "129.00", compareAtPrice: "159.00", inventoryPolicy: "DENY", taxable: true, selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Blu" }], media: { nodes: [{ id: "gid://shopify/MediaImage/3100001" }] }, inventoryItem: { id: "gid://shopify/InventoryItem/4500001", legacyResourceId: "4500001", tracked: true, requiresShipping: true, harmonizedSystemCode: "620193", countryCodeOfOrigin: "IT", unitCost: { amount: "48.5", currencyCode: "EUR" }, measurement: { weight: { value: 0.8, unit: "KILOGRAMS" } } } },
      { id: "gid://shopify/ProductVariant/4100004", legacyResourceId: "4100004", sku: "GIA-L-BLU", barcode: null, title: "L / Blu", price: "129.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", taxable: false, selectedOptions: [{ name: "Size", value: "L" }, { name: "Color", value: "Blu" }], media: { nodes: [] }, inventoryItem: { id: "gid://shopify/InventoryItem/4500004", legacyResourceId: "4500004", tracked: false, requiresShipping: false, harmonizedSystemCode: null, countryCodeOfOrigin: null, unitCost: null, measurement: { weight: { value: 800, unit: "GRAMS" } } } },
    ],
  },
};

export const graphqlProductsPage = {
  data: { products: { nodes: [graphqlProductNode], pageInfo: { hasNextPage: false, endCursor: null } } },
};

/** The second media page of product 8100001 (`PRODUCT_MEDIA_PAGE`). */
export const graphqlProductMediaPage2 = {
  data: { product: { media: { nodes: [{ id: "gid://shopify/Model3d/3100003", alt: "3D", mediaContentType: "MODEL_3D", preview: { image: { url: "https://cdn.example/giacca-3d.jpg", width: 800, height: 800 } } }], pageInfo: { hasNextPage: false, endCursor: null } } } },
};

export const graphqlProduct = { data: { product: { ...graphqlProductNode, media: { ...graphqlProductNode.media, pageInfo: { hasNextPage: false, endCursor: null } } } } };

/** `productUpdate(product:)` answering the product after the write. */
export const graphqlProductUpdate = {
  data: { productUpdate: { product: { ...graphqlProductNode, title: "Giacca Primavera Light", tags: ["new-in", "light"], updatedAt: "2026-09-21T09:00:00Z", seo: { title: "Giacca Light", description: "Nuova descrizione" }, media: { ...graphqlProductNode.media, pageInfo: { hasNextPage: false, endCursor: null } } }, userErrors: [] } },
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

export const graphqlWebhooks = { data: { webhookSubscriptions: { nodes: [{ topic: "ORDERS_CREATE", endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: "https://hullwise.example/api/webhooks/shopify" } }] } } };
export const graphqlWebhookCreate = { data: { webhookSubscriptionCreate: { userErrors: [] } } };
export const graphqlCancel = { data: { orderCancel: { job: { id: "gid://shopify/Job/1" }, orderCancelUserErrors: [], userErrors: [] } } };

/** inventoryItemUpdate with a cost (Admin GraphQL 2025-01). */
export const graphqlInventoryItemUpdate = { data: { inventoryItemUpdate: { inventoryItem: { id: "gid://shopify/InventoryItem/4500001", unitCost: { amount: "52.0" } }, userErrors: [] } } };
export const graphqlVariantInventoryItem = { data: { productVariant: { inventoryItem: { id: "gid://shopify/InventoryItem/4500004" } } } };

/** `order.fulfillmentOrders` with holds (recorded shape, Admin API 2025-07): one open, one already held by Hullwise, one closed. */
export const graphqlFulfillmentOrders = { data: { order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/701", status: "OPEN", fulfillmentHolds: [] }, { id: "gid://shopify/FulfillmentOrder/702", status: "ON_HOLD", fulfillmentHolds: [{ id: "gid://shopify/FulfillmentHold/81", handle: "hullwise-awaiting-stock" }, { id: "gid://shopify/FulfillmentHold/82", handle: null }] }, { id: "gid://shopify/FulfillmentOrder/703", status: "CLOSED", fulfillmentHolds: [] }] } } } };
export const graphqlFulfillmentOrderHold = { data: { fulfillmentOrderHold: { fulfillmentHold: { id: "gid://shopify/FulfillmentHold/83" }, userErrors: [] } } };
export const graphqlFulfillmentOrderReleaseHold = { data: { fulfillmentOrderReleaseHold: { fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/702", status: "ON_HOLD" }, userErrors: [] } } };

/* Shopify Payments (issue #27). Shapes follow the 2025-07 Admin API docs; to verify on a real account (no live recording yet). */
export const graphqlPayouts = {
  data: {
    shopifyPaymentsAccount: {
      payouts: {
        nodes: [
          { id: "gid://shopify/ShopifyPaymentsPayout/88001", legacyResourceId: "88001", issuedAt: "2026-09-29T08:00:00Z", status: "PAID", net: { amount: "176.02", currencyCode: "EUR" }, summary: { chargesGross: { amount: "226.00" }, chargesFee: { amount: "3.98" }, refundsFeeGross: { amount: "45.00" }, refundsFee: { amount: "0.00" }, adjustmentsGross: { amount: "-1.00" }, adjustmentsFee: { amount: "0.00" }, reservedFundsGross: { amount: "0.00" }, reservedFundsFee: { amount: "0.00" }, retriedPayoutsGross: { amount: "0.00" }, retriedPayoutsFee: { amount: "0.00" } } },
          { id: "gid://shopify/ShopifyPaymentsPayout/88002", legacyResourceId: "88002", issuedAt: "2026-10-01T08:00:00Z", status: "IN_TRANSIT", net: { amount: "48.99", currencyCode: "EUR" }, summary: { chargesGross: { amount: "50.00" }, chargesFee: { amount: "1.01" }, refundsFeeGross: { amount: "0.00" }, refundsFee: { amount: "0.00" }, adjustmentsGross: { amount: "0.00" }, adjustmentsFee: { amount: "0.00" }, reservedFundsGross: { amount: "0.00" }, reservedFundsFee: { amount: "0.00" }, retriedPayoutsGross: { amount: "0.00" }, retriedPayoutsFee: { amount: "0.00" } } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "eyJsYXN0X2lkIjo4ODAwMn0=" },
      },
    },
  },
};
export const graphqlBalanceTransactions = {
  data: {
    shopifyPaymentsAccount: {
      balanceTransactions: {
        nodes: [
          { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/71001", type: "CHARGE", test: false, transactionDate: "2026-09-27T10:15:02Z", amount: { amount: "176.00", currencyCode: "EUR" }, fee: { amount: "2.89" }, net: { amount: "173.11" }, associatedOrder: { id: "gid://shopify/Order/5678901234567" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/88001" } },
          { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/71002", type: "CHARGE", test: false, transactionDate: "2026-09-27T11:40:00Z", amount: { amount: "50.00", currencyCode: "EUR" }, fee: { amount: "1.09" }, net: { amount: "48.91" }, associatedOrder: { id: "gid://shopify/Order/5678901234568" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/88001" } },
          { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/71003", type: "REFUND", test: false, transactionDate: "2026-09-27T16:00:00Z", amount: { amount: "-45.00", currencyCode: "EUR" }, fee: { amount: "0.00" }, net: { amount: "-45.00" }, associatedOrder: { id: "gid://shopify/Order/5678901230001" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/88001" } },
          { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/71004", type: "ADJUSTMENT", test: false, transactionDate: "2026-09-28T07:00:00Z", amount: { amount: "-1.00", currencyCode: "EUR" }, fee: { amount: "0.00" }, net: { amount: "-1.00" }, associatedOrder: null, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/88001" } },
          { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/71005", type: "CHARGE", test: true, transactionDate: "2026-09-28T09:00:00Z", amount: { amount: "10.00", currencyCode: "EUR" }, fee: { amount: "0.40" }, net: { amount: "9.60" }, associatedOrder: { id: "gid://shopify/Order/1" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/88001" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
};
export const graphqlNoPaymentsAccount = { data: { shopifyPaymentsAccount: null } };
export const graphqlMarkAsPaid = { data: { orderMarkAsPaid: { order: { id: "gid://shopify/Order/5678901234567", displayFinancialStatus: "PAID" }, userErrors: [] } } };
export const graphqlManualPayment = { data: { orderCreateManualPayment: { order: { id: "gid://shopify/Order/5678901234567", displayFinancialStatus: "PARTIALLY_PAID" }, userErrors: [] } } };

/* Returns and discount lifecycle (issue #35): recorded shapes, field names to verify against the live API. */
export const graphqlReturnsPage = {
  data: {
    orders: {
      nodes: [
        {
          legacyResourceId: "5678901234567",
          returns: { nodes: [{ id: "gid://shopify/Return/501", status: "OPEN", createdAt: "2026-09-30T09:00:00Z", closedAt: null, order: { legacyResourceId: "5678901234567" }, returnLineItems: { nodes: [{ id: "gid://shopify/ReturnLineItem/601", quantity: 1, returnReason: "SIZE_TOO_SMALL", returnReasonNote: "", customerNote: "Too tight on the shoulders", fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/1001" } } }] } }] },
        },
        { legacyResourceId: "5678901234570", returns: { nodes: [{ id: "gid://shopify/Return/502", status: "CLOSED", createdAt: "2026-09-20T09:00:00Z", closedAt: "2026-09-27T16:00:00Z", order: { legacyResourceId: "5678901234570" }, returnLineItems: { nodes: [{ id: "gid://shopify/ReturnLineItem/602", quantity: 2, returnReason: "DEFECTIVE", returnReasonNote: "Seam open", customerNote: null, fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/1101" } } }] } }] } },
      ],
      pageInfo: { hasNextPage: true, endCursor: "eyJsYXN0X2lkIjo1Njc4OTAxMjM0NTcwfQ==" },
    },
  },
};
export const graphqlReturn = { data: { return: graphqlReturnsPage.data.orders.nodes[0]!.returns.nodes[0] } };
export const restReturnWebhook = {
  id: 501,
  admin_graphql_api_id: "gid://shopify/Return/501",
  status: "requested",
  name: "#NW1042-R1",
  created_at: "2026-09-30T09:00:00Z",
  order: { id: 5678901234567, admin_graphql_api_id: "gid://shopify/Order/5678901234567" },
  return_line_items: [{ id: 601, admin_graphql_api_id: "gid://shopify/ReturnLineItem/601", quantity: 1, return_reason: "size_too_small", return_reason_note: "", customer_note: "Too tight on the shoulders", fulfillment_line_item: { id: 701, line_item: { id: 1001 } } }],
};
export const restReturnApproveWebhook = { id: 501, admin_graphql_api_id: "gid://shopify/Return/501", status: "open", order: { id: 5678901234567 } };
export const graphqlDiscountDeactivate = { data: { discountCodeDeactivate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/9001" }, userErrors: [] } } };
export const graphqlDiscountByCode = { data: { codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/9002" } } };
export const graphqlRedeemCodeBulkDelete = { data: { discountCodeRedeemCodeBulkDelete: { job: { id: "gid://shopify/Job/77" }, userErrors: [] } } };
export const graphqlRedeemCodeBulkAdd = { data: { discountRedeemCodeBulkAdd: { bulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/5" }, userErrors: [] } } };
