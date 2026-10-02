import { normalizePaymentMethod, type PaymentStatus, type ShipmentStatus } from "@hullwise/core";
import type { Address, NormalizedCustomer, NormalizedDiscount, NormalizedFulfillment, NormalizedInventoryLevel, NormalizedLocation, NormalizedOrder, NormalizedOrderLine, NormalizedProduct, NormalizedReturn, NormalizedVariant, NormalizedMedia } from "../types";

/* ---------- helpers ---------- */

export function gidToId(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1]! : gid;
}
export function idToGid(kind: string, id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/${kind}/${id}`;
}
export function moneyToMinor(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  return Math.round(Number(amount) * 100);
}
function date(v: string | null | undefined): Date | null {
  return v ? new Date(v) : null;
}
function str(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}
function tags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Shopify financial_status → canonical payment status (tags never involved). */
export function mapFinancialStatus(s: string | null | undefined): PaymentStatus {
  switch ((s ?? "").toLowerCase()) {
    case "paid":
    case "partially_paid":
      return "paid";
    case "partially_refunded":
      return "partially_refunded";
    case "refunded":
      return "refunded";
    case "voided":
      return "voided";
    default:
      return "pending";
  }
}

/** Fulfillment shipment_status (REST) / displayStatus (GraphQL) → canonical shipment status. */
export function mapFulfillmentStatus(shipmentStatus: string | null | undefined, fulfillmentStatus: string | null | undefined): ShipmentStatus {
  const s = (shipmentStatus ?? "").toLowerCase();
  const f = (fulfillmentStatus ?? "").toLowerCase();
  if (f === "cancelled" || f === "canceled") return "failed";
  switch (s) {
    case "label_printed":
    case "label_purchased":
    case "ready_for_pickup":
    case "confirmed":
      return "label_created";
    case "in_transit":
    case "picked_up":
      return "in_transit";
    case "out_for_delivery":
      return "out_for_delivery";
    case "attempted_delivery":
      return "attempted";
    case "delivered":
      return "delivered";
    case "failure":
      return "exception";
    default:
      return f === "success" ? "in_transit" : "pending";
  }
}

function mapAddress(a: Record<string, unknown> | null | undefined): Address | null {
  if (!a) return null;
  return { name: str(a.name) ?? ([a.first_name, a.last_name].filter(Boolean).join(" ") || null), address1: str(a.address1), address2: str(a.address2), city: str(a.city), province: str(a.province ?? a.province_code), zip: str(a.zip), country: str(a.country_code ?? a.countryCodeV2 ?? a.country), phone: str(a.phone) };
}

/* ---------- REST (webhook payloads) ---------- */

type Rec = Record<string, unknown>;

export function mapRestCustomer(c: Rec | null | undefined, fallback: { email?: string | null; phone?: string | null; address?: Address | null } = {}): NormalizedCustomer | null {
  if (!c || c.id === undefined || c.id === null) return null;
  const emailConsent = (c.email_marketing_consent as Rec | undefined)?.state;
  const smsConsent = (c.sms_marketing_consent as Rec | undefined)?.state;
  const addr = (c.default_address as Rec | undefined) ?? null;
  return {
    externalId: String(c.id),
    email: str(c.email) ?? fallback.email ?? null,
    phone: str(c.phone) ?? str(addr?.phone) ?? fallback.phone ?? null,
    firstName: str(c.first_name),
    lastName: str(c.last_name),
    country: str(addr?.country_code) ?? fallback.address?.country ?? null,
    city: str(addr?.city) ?? fallback.address?.city ?? null,
    zip: str(addr?.zip) ?? fallback.address?.zip ?? null,
    acceptsMarketing: emailConsent === "subscribed" || smsConsent === "subscribed" || c.accepts_marketing === true,
    tags: tags(c.tags),
    platformCreatedAt: date(c.created_at as string),
  };
}

function mapRestLine(l: Rec): NormalizedOrderLine {
  const qty = Number(l.quantity ?? 0);
  const current = l.current_quantity === undefined ? qty : Number(l.current_quantity);
  const unit = moneyToMinor(l.price as string);
  const discount = (Array.isArray(l.discount_allocations) ? (l.discount_allocations as Rec[]) : []).reduce((s, d) => s + moneyToMinor(d.amount as string), 0);
  return { externalId: String(l.id), variantExternalId: l.variant_id ? String(l.variant_id) : null, productExternalId: l.product_id ? String(l.product_id) : null, sku: str(l.sku), title: String(l.title ?? l.name ?? ""), variantTitle: str(l.variant_title), quantity: qty, currentQuantity: current, unitPriceMinor: unit, discountMinor: discount, totalMinor: unit * qty - discount };
}

function mapRestFulfillment(f: Rec): NormalizedFulfillment {
  const status = mapFulfillmentStatus(f.shipment_status as string, f.status as string);
  return { externalId: String(f.id), status, externalStatus: str(f.shipment_status) ?? str(f.status), trackingNumber: str(f.tracking_number) ?? (Array.isArray(f.tracking_numbers) ? str((f.tracking_numbers as string[])[0]) : null), trackingUrl: str(f.tracking_url) ?? (Array.isArray(f.tracking_urls) ? str((f.tracking_urls as string[])[0]) : null), carrier: str(f.tracking_company), createdAt: new Date(String(f.created_at)), updatedAt: new Date(String(f.updated_at ?? f.created_at)), deliveredAt: status === "delivered" ? new Date(String(f.updated_at ?? f.created_at)) : null };
}

/** orders/* webhook payload → NormalizedOrder. Tags are carried as data, never interpreted here. */
export function mapRestOrder(p: Rec): NormalizedOrder {
  const shipping = mapAddress(p.shipping_address as Rec);
  const customer = mapRestCustomer(p.customer as Rec, { email: str(p.email) ?? str(p.contact_email), phone: str(p.phone), address: shipping });
  const lines = (Array.isArray(p.line_items) ? (p.line_items as Rec[]) : []).map(mapRestLine);
  const discountCodes = Array.isArray(p.discount_codes) ? (p.discount_codes as Rec[]) : [];
  const discounts = discountCodes.map((d) => ({ code: String(d.code ?? ""), type: (d.type === "shipping" ? "free_shipping" : d.type === "fixed_amount" ? "fixed_amount" : "percentage") as "percentage" | "fixed_amount" | "free_shipping", amountMinor: moneyToMinor(d.amount as string) })).filter((d) => d.code);
  const refunded = (Array.isArray(p.refunds) ? (p.refunds as Rec[]) : []).reduce((s, r) => s + (Array.isArray(r.transactions) ? (r.transactions as Rec[]).filter((t) => t.kind === "refund" && t.status === "success").reduce((a, t) => a + moneyToMinor(t.amount as string), 0) : 0), 0);
  const gateways = Array.isArray(p.payment_gateway_names) ? (p.payment_gateway_names as string[]) : p.gateway ? [String(p.gateway)] : [];
  const shippingMinor = (Array.isArray(p.shipping_lines) ? (p.shipping_lines as Rec[]) : []).reduce((s, l) => s + moneyToMinor(l.price as string), 0);
  const name = String(p.name ?? `#${p.order_number ?? p.id}`);
  const customerName = [((p.customer as Rec | undefined)?.first_name as string) ?? shipping?.name, (p.customer as Rec | undefined)?.last_name as string].filter(Boolean).join(" ") || shipping?.name || null;
  return {
    externalId: String(p.id),
    orderNumber: Number(p.order_number ?? p.number ?? 0),
    name,
    customer,
    email: str(p.email) ?? str(p.contact_email),
    phone: str(p.phone) ?? shipping?.phone ?? null,
    customerName,
    currency: String(p.currency ?? p.presentment_currency ?? "EUR"),
    subtotalMinor: moneyToMinor(p.subtotal_price as string) || lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0),
    discountMinor: moneyToMinor(p.total_discounts as string),
    shippingMinor,
    taxMinor: moneyToMinor(p.total_tax as string),
    totalMinor: moneyToMinor(p.total_price as string),
    refundedMinor: refunded,
    paymentGateways: gateways,
    paymentMethod: normalizePaymentMethod(gateways),
    paymentStatus: mapFinancialStatus(p.financial_status as string),
    financialStatusRaw: str(p.financial_status),
    fulfillmentStatusRaw: str(p.fulfillment_status),
    tags: tags(p.tags),
    shippingAddress: shipping,
    billingAddress: mapAddress(p.billing_address as Rec),
    note: str(p.note),
    noteAttributes: (Array.isArray(p.note_attributes) ? (p.note_attributes as Rec[]) : []).map((n) => ({ name: String(n.name ?? ""), value: String(n.value ?? "") })),
    landingSite: str(p.landing_site),
    referringSite: str(p.referring_site),
    sourceChannel: String(p.source_name ?? "web"),
    placedAt: new Date(String(p.created_at ?? p.processed_at)),
    cancelledAt: date(p.cancelled_at as string),
    cancelReason: str(p.cancel_reason),
    closedAt: date(p.closed_at as string),
    platformUpdatedAt: new Date(String(p.updated_at ?? p.created_at)),
    lines,
    discounts,
    fulfillments: (Array.isArray(p.fulfillments) ? (p.fulfillments as Rec[]) : []).map(mapRestFulfillment),
  };
}

/** products/* webhook payload (REST shape). */
export function mapRestProduct(p: Rec): NormalizedProduct {
  const options = (Array.isArray(p.options) ? (p.options as Rec[]) : []).map((o) => ({ name: String(o.name ?? ""), values: ((o.values as string[] | undefined) ?? []).map(String) }));
  const variants: NormalizedVariant[] = (Array.isArray(p.variants) ? (p.variants as Rec[]) : []).map((v) => ({
    externalId: String(v.id),
    inventoryItemExternalId: v.inventory_item_id ? String(v.inventory_item_id) : null,
    sku: str(v.sku),
    barcode: str(v.barcode),
    title: String(v.title ?? ""),
    optionValues: Object.fromEntries(options.map((o, i) => [o.name, String(v[`option${i + 1}`] ?? "")]).filter(([, val]) => val !== "")),
    priceMinor: moneyToMinor(v.price as string),
    compareAtMinor: v.compare_at_price ? moneyToMinor(v.compare_at_price as string) : null,
    weightGrams: v.grams !== undefined && v.grams !== null ? Number(v.grams) : null,
    ...(v.inventory_policy !== undefined ? { inventoryPolicy: String(v.inventory_policy) === "continue" ? ("continue" as const) : ("deny" as const) } : {}),
    ...(v.taxable !== undefined ? { taxable: v.taxable === true } : {}),
  }));
  // media ids of the REST payload are not the GraphQL media ids: the webhook handler reads the product back (`fetchProduct`)
  return { externalId: String(p.id), title: String(p.title ?? ""), handle: str(p.handle), vendor: str(p.vendor), productType: str(p.product_type), status: (String(p.status ?? "active").toLowerCase() as "active" | "draft" | "archived"), tags: tags(p.tags), options, imageUrl: str((p.image as Rec | undefined)?.src), platformCreatedAt: date(p.created_at as string), variants, ...(p.updated_at !== undefined ? { platformUpdatedAt: date(p.updated_at as string) } : {}), ...(p.body_html !== undefined ? { descriptionHtml: str(p.body_html) } : {}) };
}

/** inventory_levels/update webhook payload. */
export function mapRestInventoryLevel(p: Rec): NormalizedInventoryLevel {
  return { inventoryItemExternalId: String(p.inventory_item_id), locationExternalId: String(p.location_id), available: Number(p.available ?? 0), onHand: null, committed: null, updatedAt: date(p.updated_at as string) ?? new Date() };
}

/* ---------- GraphQL (Admin API) ---------- */

export const ORDER_FIELDS = `
  id legacyResourceId name email phone note tags createdAt updatedAt cancelledAt cancelReason closedAt processedAt
  currencyCode displayFinancialStatus displayFulfillmentStatus paymentGatewayNames sourceName landingPageUrl referrerUrl
  customAttributes { key value }
  subtotalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } } totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
  customer { id legacyResourceId email phone firstName lastName tags createdAt emailMarketingConsent { marketingState } smsMarketingConsent { marketingState } defaultAddress { city zip countryCodeV2 phone } }
  shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
  billingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
  discountCodes
  discountApplications(first: 10) { nodes { __typename ... on DiscountCodeApplication { code value { __typename ... on MoneyV2 { amount } ... on PricingPercentageValue { percentage } } } } }
  lineItems(first: 100) { nodes { id quantity currentQuantity sku title variantTitle variant { legacyResourceId } product { legacyResourceId } originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } } }
  fulfillments(first: 20) { id legacyResourceId status displayStatus createdAt updatedAt deliveredAt trackingInfo { number url company } }
`;

export function mapGraphqlOrder(n: Rec): NormalizedOrder {
  const money = (set: unknown) => moneyToMinor(((set as Rec | undefined)?.shopMoney as Rec | undefined)?.amount as string);
  const cust = n.customer as Rec | null;
  const addr = (a: Rec | null | undefined): Address | null => (a ? { name: str(a.name), address1: str(a.address1), address2: str(a.address2), city: str(a.city), province: str(a.provinceCode), zip: str(a.zip), country: str(a.countryCodeV2), phone: str(a.phone) } : null);
  const shipping = addr(n.shippingAddress as Rec);
  const customer: NormalizedCustomer | null = cust
    ? { externalId: String(cust.legacyResourceId ?? gidToId(cust.id as string)), email: str(cust.email), phone: str(cust.phone) ?? str((cust.defaultAddress as Rec | undefined)?.phone), firstName: str(cust.firstName), lastName: str(cust.lastName), country: str((cust.defaultAddress as Rec | undefined)?.countryCodeV2) ?? shipping?.country ?? null, city: str((cust.defaultAddress as Rec | undefined)?.city) ?? shipping?.city ?? null, zip: str((cust.defaultAddress as Rec | undefined)?.zip) ?? shipping?.zip ?? null, acceptsMarketing: (cust.emailMarketingConsent as Rec | undefined)?.marketingState === "SUBSCRIBED" || (cust.smsMarketingConsent as Rec | undefined)?.marketingState === "SUBSCRIBED", tags: tags(cust.tags), platformCreatedAt: date(cust.createdAt as string) }
    : null;
  const lines: NormalizedOrderLine[] = (((n.lineItems as Rec | undefined)?.nodes as Rec[] | undefined) ?? []).map((l) => {
    const qty = Number(l.quantity ?? 0);
    const unit = money(l.originalUnitPriceSet);
    const discount = money(l.totalDiscountSet);
    return { externalId: String(gidToId(l.id as string)), variantExternalId: str((l.variant as Rec | null)?.legacyResourceId), productExternalId: str((l.product as Rec | null)?.legacyResourceId), sku: str(l.sku), title: String(l.title ?? ""), variantTitle: str(l.variantTitle), quantity: qty, currentQuantity: l.currentQuantity === undefined ? qty : Number(l.currentQuantity), unitPriceMinor: unit, discountMinor: discount, totalMinor: unit * qty - discount };
  });
  const apps = (((n.discountApplications as Rec | undefined)?.nodes as Rec[] | undefined) ?? []).filter((a) => a.__typename === "DiscountCodeApplication");
  const discounts = apps.map((a) => {
    const v = a.value as Rec;
    const isPct = v.__typename === "PricingPercentageValue";
    return { code: String(a.code), type: (isPct ? "percentage" : "fixed_amount") as "percentage" | "fixed_amount", amountMinor: isPct ? 0 : moneyToMinor(v.amount as string) };
  });
  if (discounts.length === 1 && discounts[0]!.amountMinor === 0) discounts[0]!.amountMinor = money(n.totalDiscountsSet);
  const gateways = Array.isArray(n.paymentGatewayNames) ? (n.paymentGatewayNames as string[]) : [];
  const fin = String(n.displayFinancialStatus ?? "").toLowerCase();
  return {
    externalId: String(n.legacyResourceId ?? gidToId(n.id as string)),
    orderNumber: Number(String(n.name ?? "").replace(/\D+/g, "")) || 0,
    name: String(n.name ?? ""),
    customer,
    email: str(n.email),
    phone: str(n.phone) ?? shipping?.phone ?? null,
    customerName: [cust?.firstName, cust?.lastName].filter(Boolean).join(" ") || shipping?.name || null,
    currency: String(n.currencyCode ?? "EUR"),
    subtotalMinor: money(n.subtotalPriceSet),
    discountMinor: money(n.totalDiscountsSet),
    shippingMinor: money(n.totalShippingPriceSet),
    taxMinor: money(n.totalTaxSet),
    totalMinor: money(n.totalPriceSet),
    refundedMinor: money(n.totalRefundedSet),
    paymentGateways: gateways,
    paymentMethod: normalizePaymentMethod(gateways),
    paymentStatus: mapFinancialStatus(fin),
    financialStatusRaw: fin || null,
    fulfillmentStatusRaw: str(n.displayFulfillmentStatus)?.toLowerCase() ?? null,
    tags: tags(n.tags),
    shippingAddress: shipping,
    billingAddress: addr(n.billingAddress as Rec),
    note: str(n.note),
    noteAttributes: ((n.customAttributes as Rec[] | undefined) ?? []).map((a) => ({ name: String(a.key ?? ""), value: String(a.value ?? "") })),
    landingSite: str(n.landingPageUrl),
    referringSite: str(n.referrerUrl),
    sourceChannel: String(n.sourceName ?? "web"),
    placedAt: new Date(String(n.createdAt)),
    cancelledAt: date(n.cancelledAt as string),
    cancelReason: str(n.cancelReason)?.toLowerCase() ?? null,
    closedAt: date(n.closedAt as string),
    platformUpdatedAt: new Date(String(n.updatedAt ?? n.createdAt)),
    lines,
    discounts,
    fulfillments: ((n.fulfillments as Rec[] | undefined) ?? []).map((f) => {
      const status = mapFulfillmentStatus(String(f.displayStatus ?? "").toLowerCase(), String(f.status ?? "").toLowerCase());
      const ti = Array.isArray(f.trackingInfo) ? (f.trackingInfo as Rec[])[0] : undefined;
      return { externalId: String(f.legacyResourceId ?? gidToId(f.id as string)), status, externalStatus: str(f.displayStatus)?.toLowerCase() ?? null, trackingNumber: str(ti?.number), trackingUrl: str(ti?.url), carrier: str(ti?.company), createdAt: new Date(String(f.createdAt)), updatedAt: new Date(String(f.updatedAt ?? f.createdAt)), deliveredAt: date(f.deliveredAt as string) ?? (status === "delivered" ? new Date(String(f.updatedAt ?? f.createdAt)) : null) };
    }),
  };
}

/** Media page size inside the product query; a product with more media is completed by `PRODUCT_MEDIA_PAGE`. */
export const PRODUCT_MEDIA_FIRST = 50;
/** Metafields mirrored per product (read-only; first N in the platform's order). */
export const PRODUCT_METAFIELDS_FIRST = 30;
export const MEDIA_FIELDS = `id alt mediaContentType preview { image { url width height } } ... on MediaImage { image { url width height } }`;

/**
 * One product query for sync, webhooks and write-backs (issue #19 merged into the #23 query: the
 * variant's `inventoryItem.unitCost` stays here, cost rules unchanged). Field names to verify on a
 * live store: `category.fullName`, `resourcePublications` (needs read_publications), variant `media`.
 */
export const PRODUCT_FIELDS = `
  id legacyResourceId title handle vendor productType status tags createdAt updatedAt descriptionHtml
  seo { title description }
  category { id name fullName }
  options { name values }
  featuredMedia { preview { image { url } } }
  media(first: ${PRODUCT_MEDIA_FIRST}) { nodes { ${MEDIA_FIELDS} } pageInfo { hasNextPage endCursor } }
  collections(first: 20) { nodes { id title handle } }
  resourcePublications(first: 20) { nodes { isPublished publishDate publication { id name } } }
  metafields(first: ${PRODUCT_METAFIELDS_FIRST}) { nodes { namespace key type value } }
  variants(first: 100) { nodes { id legacyResourceId sku barcode title price compareAtPrice inventoryPolicy taxable selectedOptions { name value } media(first: 1) { nodes { id } } inventoryItem { id legacyResourceId tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin unitCost { amount currencyCode } measurement { weight { value unit } } } } }
`;

/** The next media page of one product (products with more than `PRODUCT_MEDIA_FIRST` media). */
export const PRODUCT_MEDIA_PAGE = `query($id: ID!, $after: String) { product(id: $id) { media(first: ${PRODUCT_MEDIA_FIRST}, after: $after) { nodes { ${MEDIA_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;

const MEDIA_TYPES: Record<string, NormalizedMedia["type"]> = { IMAGE: "image", VIDEO: "video", EXTERNAL_VIDEO: "video", MODEL_3D: "model" };

/** A GraphQL media node; null when it has no image to show yet (still processing). */
export function mapGraphqlMedia(m: Rec): NormalizedMedia | null {
  const img = ((m.image as Rec | null | undefined) ?? ((m.preview as Rec | null | undefined)?.image as Rec | null | undefined)) ?? null;
  const url = str(img?.url);
  if (!m.id || !url) return null;
  return { externalId: String(m.id), type: MEDIA_TYPES[String(m.mediaContentType ?? "IMAGE")] ?? "image", url, alt: str(m.alt), width: img?.width === undefined || img?.width === null ? null : Number(img.width), height: img?.height === undefined || img?.height === null ? null : Number(img.height) };
}

const nodes = (v: unknown): Rec[] => (((v as Rec | undefined)?.nodes as Rec[] | undefined) ?? []);

export function mapGraphqlProduct(n: Rec): NormalizedProduct {
  const variants: NormalizedVariant[] = nodes(n.variants).map((v) => {
    const item = (v.inventoryItem as Rec | undefined) ?? {};
    const w = ((item.measurement as Rec | undefined)?.weight as Rec | undefined) ?? null;
    const grams = w ? Math.round(Number(w.value) * (w.unit === "KILOGRAMS" ? 1000 : w.unit === "POUNDS" ? 453.592 : w.unit === "OUNCES" ? 28.3495 : 1)) : null;
    // unitCost is in the shop currency; null when the merchant never entered a cost
    const unitCost = (item.unitCost as Rec | null | undefined)?.amount;
    const bool = (x: unknown) => (x === undefined || x === null ? null : x === true);
    return {
      externalId: String(v.legacyResourceId ?? gidToId(v.id as string)), inventoryItemExternalId: str(item.legacyResourceId) ?? gidToId(item.id as string), sku: str(v.sku), barcode: str(v.barcode), title: String(v.title ?? ""),
      optionValues: Object.fromEntries(((v.selectedOptions as Rec[] | undefined) ?? []).map((o) => [String(o.name), String(o.value)])), priceMinor: moneyToMinor(v.price as string), compareAtMinor: v.compareAtPrice ? moneyToMinor(v.compareAtPrice as string) : null, weightGrams: grams,
      costMinor: unitCost === null || unitCost === undefined || unitCost === "" ? null : moneyToMinor(String(unitCost)),
      ...(v.media !== undefined ? { imageMediaExternalId: str(nodes(v.media)[0]?.id) } : {}),
      ...(v.inventoryPolicy !== undefined ? { inventoryPolicy: String(v.inventoryPolicy).toLowerCase() === "continue" ? ("continue" as const) : ("deny" as const) } : {}),
      ...(v.taxable !== undefined ? { taxable: bool(v.taxable) } : {}),
      ...(item.tracked !== undefined ? { tracksInventory: bool(item.tracked) } : {}),
      ...(item.requiresShipping !== undefined ? { requiresShipping: bool(item.requiresShipping) } : {}),
      ...(item.harmonizedSystemCode !== undefined ? { hsCode: str(item.harmonizedSystemCode) } : {}),
      ...(item.countryCodeOfOrigin !== undefined ? { countryOfOrigin: str(item.countryCodeOfOrigin) } : {}),
    };
  });
  const cat = n.category as Rec | null | undefined;
  const seo = n.seo as Rec | null | undefined;
  return {
    externalId: String(n.legacyResourceId ?? gidToId(n.id as string)), title: String(n.title ?? ""), handle: str(n.handle), vendor: str(n.vendor), productType: str(n.productType), status: String(n.status ?? "ACTIVE").toLowerCase() as "active" | "draft" | "archived", tags: tags(n.tags),
    options: ((n.options as Rec[] | undefined) ?? []).map((o) => ({ name: String(o.name), values: ((o.values as string[] | undefined) ?? []).map(String) })),
    imageUrl: str((((n.featuredMedia as Rec | undefined)?.preview as Rec | undefined)?.image as Rec | undefined)?.url), platformCreatedAt: date(n.createdAt as string), variants,
    ...(n.updatedAt !== undefined ? { platformUpdatedAt: date(n.updatedAt as string) } : {}),
    ...(n.descriptionHtml !== undefined ? { descriptionHtml: str(n.descriptionHtml) } : {}),
    ...(n.seo !== undefined ? { seo: { title: str(seo?.title), description: str(seo?.description) } } : {}),
    ...(n.category !== undefined ? { category: cat?.id ? { id: String(cat.id), name: String(cat.fullName ?? cat.name ?? "") } : null } : {}),
    ...(n.collections !== undefined ? { collections: nodes(n.collections).map((c) => ({ id: String(c.id), title: String(c.title ?? ""), handle: str(c.handle) })) } : {}),
    ...(n.resourcePublications !== undefined ? { publishedChannels: nodes(n.resourcePublications).map((r) => ({ id: String((r.publication as Rec | undefined)?.id ?? ""), name: String((r.publication as Rec | undefined)?.name ?? ""), published: r.isPublished === true, publishedAt: str(r.publishDate) })).filter((r) => r.id) } : {}),
    ...(n.metafields !== undefined ? { metafields: nodes(n.metafields).map((m) => ({ namespace: String(m.namespace ?? ""), key: String(m.key ?? ""), type: String(m.type ?? ""), value: String(m.value ?? "") })) } : {}),
    ...(n.media !== undefined ? { media: nodes(n.media).map(mapGraphqlMedia).filter((m): m is NormalizedMedia => m !== null) } : {}),
  };
}

export function mapGraphqlCustomer(n: Rec): NormalizedCustomer {
  const a = (n.defaultAddress as Rec | undefined) ?? null;
  return { externalId: String(n.legacyResourceId ?? gidToId(n.id as string)), email: str(n.email), phone: str(n.phone) ?? str(a?.phone), firstName: str(n.firstName), lastName: str(n.lastName), country: str(a?.countryCodeV2), city: str(a?.city), zip: str(a?.zip), acceptsMarketing: (n.emailMarketingConsent as Rec | undefined)?.marketingState === "SUBSCRIBED" || (n.smsMarketingConsent as Rec | undefined)?.marketingState === "SUBSCRIBED", tags: tags(n.tags), platformCreatedAt: date(n.createdAt as string) };
}

export function mapGraphqlLocation(n: Rec): NormalizedLocation {
  return { externalId: String(n.legacyResourceId ?? gidToId(n.id as string)), name: String(n.name ?? ""), country: str((n.address as Rec | undefined)?.countryCode), isDefault: n.isPrimary === true, isActive: n.isActive !== false };
}

export function mapGraphqlInventoryLevel(itemLegacyId: string, lvl: Rec): NormalizedInventoryLevel {
  const q = Object.fromEntries((((lvl.quantities as Rec[] | undefined) ?? []).map((x) => [String(x.name), Number(x.quantity)])));
  return { inventoryItemExternalId: itemLegacyId, locationExternalId: String((lvl.location as Rec).legacyResourceId ?? gidToId((lvl.location as Rec).id as string)), available: q.available ?? 0, onHand: q.on_hand ?? null, committed: q.committed ?? null, updatedAt: date(lvl.updatedAt as string) ?? new Date() };
}

export function mapGraphqlDiscount(n: Rec): NormalizedDiscount | null {
  const d = (n.codeDiscount ?? n.discount) as Rec | undefined;
  if (!d) return null;
  const code = str(((((d.codes as Rec | undefined)?.nodes as Rec[] | undefined) ?? [])[0] as Rec | undefined)?.code) ?? `AUTO:${String(d.title ?? "")}`;
  const typename = String(d.__typename ?? "");
  const cv = (d.customerGets as Rec | undefined)?.value as Rec | undefined;
  let type: NormalizedDiscount["type"] = "percentage";
  let value = 0;
  if (typename.includes("FreeShipping")) type = "free_shipping";
  else if (cv?.__typename === "DiscountPercentage") value = Math.round(Number(cv.percentage) * 10000);
  else if (cv?.__typename === "DiscountAmount") {
    type = "fixed_amount";
    value = moneyToMinor((cv.amount as Rec | undefined)?.amount as string);
  }
  const min = (d.minimumRequirement as Rec | undefined)?.greaterThanOrEqualToSubtotal as Rec | undefined;
  return { externalId: String(gidToId(n.id as string)), code, title: str(d.title), type, value, minimumAmountMinor: min ? moneyToMinor(min.amount as string) : null, usageLimit: d.usageLimit === null || d.usageLimit === undefined ? null : Number(d.usageLimit), usedCount: Number(d.asyncUsageCount ?? 0), startsAt: date(d.startsAt as string), endsAt: date(d.endsAt as string), isActive: String(d.status ?? "ACTIVE").toUpperCase() === "ACTIVE" };
}

/* ---------- returns (issue #35; field names to verify against the live Admin API) ---------- */

export const RETURN_FIELDS = `id status createdAt closedAt order { legacyResourceId } returnLineItems(first: 50) { nodes { id quantity returnReason returnReasonNote customerNote ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } } }`;

/** A GraphQL `Return` node; `orderExternalId` comes from the node or from the enclosing order. */
export function mapGraphqlReturn(r: Rec, orderExternalId?: string | null): NormalizedReturn | null {
  const order = orderExternalId ?? str((r.order as Rec | undefined)?.legacyResourceId) ?? gidToId(str((r.order as Rec | undefined)?.id));
  if (!r.id || !order) return null;
  const lines = (((r.returnLineItems as Rec | undefined)?.nodes as Rec[] | undefined) ?? []).map((l) => ({ externalId: gidToId(str(l.id)), orderLineExternalId: gidToId(str(((l.fulfillmentLineItem as Rec | undefined)?.lineItem as Rec | undefined)?.id)) ?? "", quantity: Number(l.quantity ?? 0), reason: l.returnReason ? String(l.returnReason).toLowerCase() : null, note: str(l.customerNote) ?? str(l.returnReasonNote) }));
  return { externalId: gidToId(String(r.id))!, orderExternalId: order, status: String(r.status ?? "requested").toLowerCase(), requestedAt: new Date(String(r.createdAt)), closedAt: r.closedAt ? new Date(String(r.closedAt)) : null, note: lines.find((l) => l.note)?.note ?? null, lines: lines.filter((l) => l.orderLineExternalId && l.quantity > 0) };
}

/** A `returns/*` webhook payload (REST shape); null when it does not carry the order and the line items, so the caller reads the return instead. */
export function mapRestReturn(p: Rec): NormalizedReturn | null {
  const order = p.order as Rec | undefined;
  const orderId = str(p.order_id) ?? str(order?.id) ?? gidToId(str(order?.admin_graphql_api_id));
  const items = p.return_line_items as Rec[] | undefined;
  if (!p.id || !orderId || !Array.isArray(items) || !items.length) return null;
  const lines = items.map((l) => {
    const li = (l.fulfillment_line_item as Rec | undefined)?.line_item as Rec | undefined;
    return { externalId: str(l.id), orderLineExternalId: str(li?.id) ?? "", quantity: Number(l.quantity ?? 0), reason: l.return_reason ? String(l.return_reason).toLowerCase() : null, note: str(l.customer_note) ?? str(l.return_reason_note) };
  });
  if (lines.some((l) => !l.orderLineExternalId)) return null;
  return { externalId: String(p.id), orderExternalId: String(orderId), status: String(p.status ?? "requested").toLowerCase(), requestedAt: new Date(String(p.created_at ?? p.updated_at ?? Date.now())), closedAt: p.closed_at ? new Date(String(p.closed_at)) : null, note: lines.find((l) => l.note)?.note ?? null, lines: lines.filter((l) => l.quantity > 0) };
}
