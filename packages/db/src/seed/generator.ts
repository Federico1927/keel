import { createRng, type Rng } from "@keel/integrations/rng";
import {
  addressKey,
  defaultStateRules,
  deriveOrderStatus,
  nameZipKey,
  normalizeEmail,
  normalizePhone,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
  type ShipmentStatus,
  type StateRule,
} from "@keel/core";
import {
  APPAREL_TEMPLATES,
  CAMPAIGN_ADJECTIVES,
  CAMPAIGN_SUFFIX,
  CARRIERS_EU,
  CARRIERS_US,
  DISCOUNT_CODES,
  EN_FIRST,
  EN_LAST,
  HOME_TEMPLATES,
  HOUR_WEIGHTS,
  IT_CITIES,
  IT_FIRST,
  IT_LAST,
  RETURN_REASONS_EN,
  RETURN_REASONS_IT,
  SEASONALITY_APPAREL,
  SEASONALITY_HOME,
  STREETS_EN,
  STREETS_IT,
  US_CITIES,
  WEEKDAY_WEIGHTS,
  type CityRow,
  type ProductTemplate,
} from "./data";

export interface TenantSeedConfig {
  key: "northwind" | "harbor";
  tenantId: string;
  seed: number;
  currency: string;
  country: string;
  timezone: string;
  locale: "it" | "en";
  orderNumberPrefix: string;
  orderCount: number;
  productCount: number;
  locationNames: string[];
  supplierNames: string[];
  metaCampaigns: number;
  googleCampaigns: number;
  codShare: number;
  returnRate: number;
  cancelRate: number;
  /** User ids of the tenant members (for notes, assignments, audit). */
  userIds: string[];
  now: Date;
}

/* ---------- row shapes (match the Drizzle insert types loosely; cast at write time) ---------- */
type Row = Record<string, unknown>;
export interface TenantDataset {
  locations: Row[];
  products: Row[];
  productVariants: Row[];
  inventoryLevels: Row[];
  inventoryMovements: Row[];
  customers: Row[];
  campaigns: Row[];
  adMetricsDaily: Row[];
  campaignProductLinks: Row[];
  discountPools: Row[];
  discounts: Row[];
  orders: Row[];
  orderLines: Row[];
  orderEvents: Row[];
  orderNotes: Row[];
  orderDiscounts: Row[];
  orderAttribution: Row[];
  shipments: Row[];
  shipmentSourceStates: Row[];
  shipmentEvents: Row[];
  shipmentStatusMappings: Row[];
  stateRules: Row[];
  costSettings: Row[];
  periodCosts: Row[];
  returnReasons: Row[];
  returnRequests: Row[];
  returnLines: Row[];
  suppliers: Row[];
  purchaseOrders: Row[];
  purchaseOrderLines: Row[];
  supplierPayments: Row[];
  backorders: Row[];
  segments: Row[];
  segmentMemberships: Row[];
  notifications: Row[];
  integrations: Row[];
  integrationHealth: Row[];
  webhookEvents: Row[];
  syncRuns: Row[];
  auditLogs: Row[];
}

const DAY = 864e5;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 36e5);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function pickWeightedCity(rng: Rng, cities: CityRow[]): CityRow {
  return rng.weighted(cities.map((c) => [c, c.weight] as const));
}

function buildPhone(rng: Rng, country: string): string {
  switch (country) {
    case "IT":
      return `+39 3${rng.int(20, 99)} ${rng.int(100, 999)} ${rng.int(1000, 9999)}`;
    case "DE":
      return `+49 15${rng.int(10, 99)} ${rng.int(1000000, 9999999)}`;
    case "FR":
      return `+33 6 ${rng.int(10, 99)} ${rng.int(10, 99)} ${rng.int(10, 99)} ${rng.int(10, 99)}`;
    case "ES":
      return `+34 6${rng.int(10, 99)} ${rng.int(100, 999)} ${rng.int(100, 999)}`;
    case "CA":
      return `+1 ${rng.pick(["416", "604", "514"])} ${rng.int(200, 999)} ${rng.int(1000, 9999)}`;
    default:
      return `+1 ${rng.pick(["212", "310", "312", "713", "602", "215", "619", "214", "512", "206", "303", "617", "305", "503"])} ${rng.int(200, 999)} ${rng.int(1000, 9999)}`;
  }
}

/** Samples a timestamp in the last 365 days with month, weekday and hour seasonality. */
function samplePlacedAt(rng: Rng, now: Date, seasonality: number[]): Date {
  for (;;) {
    const daysAgo = rng.next() * 365;
    const d = new Date(now.getTime() - daysAgo * DAY);
    const w = seasonality[d.getUTCMonth()]! * WEEKDAY_WEIGHTS[d.getUTCDay()]! * (1 + (365 - daysAgo) / 900); // mild growth trend
    if (rng.next() * 2.2 < w) {
      const hour = rng.weighted(HOUR_WEIGHTS.map((h, i) => [i, h] as const));
      d.setUTCHours(hour, rng.int(0, 59), rng.int(0, 59), 0);
      if (d > now) continue;
      return d;
    }
  }
}

export function generateTenantDataset(cfg: TenantSeedConfig): TenantDataset {
  const rng = createRng(cfg.seed);
  const { tenantId, now } = cfg;
  const isApparel = cfg.key === "northwind";
  const cities = isApparel ? IT_CITIES : US_CITIES;
  const first = isApparel ? IT_FIRST : EN_FIRST;
  const last = isApparel ? IT_LAST : EN_LAST;
  const streets = isApparel ? STREETS_IT : STREETS_EN;
  const carriers = isApparel ? CARRIERS_EU : CARRIERS_US;
  const templates = isApparel ? APPAREL_TEMPLATES : HOME_TEMPLATES;
  const seasonality = isApparel ? SEASONALITY_APPAREL : SEASONALITY_HOME;
  const ds: TenantDataset = {
    locations: [], products: [], productVariants: [], inventoryLevels: [], inventoryMovements: [], customers: [], campaigns: [], adMetricsDaily: [], campaignProductLinks: [], discountPools: [], discounts: [],
    orders: [], orderLines: [], orderEvents: [], orderNotes: [], orderDiscounts: [], orderAttribution: [], shipments: [], shipmentSourceStates: [], shipmentEvents: [], shipmentStatusMappings: [], stateRules: [], costSettings: [], periodCosts: [],
    returnReasons: [], returnRequests: [], returnLines: [], suppliers: [], purchaseOrders: [], purchaseOrderLines: [], supplierPayments: [], backorders: [], segments: [], segmentMemberships: [], notifications: [], integrations: [], integrationHealth: [], webhookEvents: [], syncRuns: [], auditLogs: [],
  };
  const t = (row: Row): Row & { id: string; tenantId: string } => ({ id: rng.uuid(), tenantId, ...row });
  let extCounter = 1000;
  const ext = () => String(++extCounter * 7919);

  /* ---------- locations ---------- */
  const locations = cfg.locationNames.map((name, i) => t({ externalId: ext(), name, country: i === 2 ? "DE" : cfg.country, isDefault: i === 0, isActive: true }));
  ds.locations.push(...locations);
  const defaultLocation = locations[0]!;

  /* ---------- products & variants ---------- */
  interface V { id: string; productId: string; externalId: string; inventoryItemExternalId: string; sku: string; title: string; productTitle: string; priceMinor: number; costMinor: number; popularity: number; optionValues: Record<string, string>; stockTotal: number; isLow: boolean; isCritical: boolean }
  const variants: V[] = [];
  const productsById = new Map<string, { id: string; title: string; templateIndex: number; popularity: number; isRepurchasable: boolean }>();
  for (let i = 0; i < cfg.productCount; i++) {
    const tpl: ProductTemplate = templates[i % templates.length]!;
    const series = Math.floor(i / templates.length);
    const title = series === 0 ? tpl.title : `${tpl.title} ${["II", "Edit", "Studio", "Classic"][series % 4]}`;
    const productId = rng.uuid();
    const pExt = ext();
    const options = tpl.options.map((o) => ({ name: o.name, values: [...o.values] }));
    const popularity = tpl.popularity * (0.6 + rng.next() * 0.8);
    const isRepurchasable = rng.chance(0.85);
    const platformCreatedAt = addDays(now, -rng.int(120, 900));
    productsById.set(productId, { id: productId, title, templateIndex: i % templates.length, popularity, isRepurchasable });
    ds.products.push({ id: productId, tenantId, externalId: pExt, title, handle: slug(title), vendor: tpl.vendor, productType: tpl.type, status: rng.chance(0.93) ? "active" : "draft", tags: [tpl.type.toLowerCase(), series ? "new" : "core"], options, imageUrl: null, isAncillary: false, isRepurchasable, platformCreatedAt, syncedAt: now });
    // cartesian product of options → variants
    const combos: Record<string, string>[] = options.reduce<Record<string, string>[]>((acc, opt) => acc.flatMap((c) => opt.values.map((v) => ({ ...c, [opt.name]: v }))), [{}]);
    const code = `${tpl.title.split(" ").map((w) => w[0]).join("").toUpperCase()}${100 + i}`;
    const lowStockProduct = rng.chance(0.12);
    combos.forEach((optionValues, vi) => {
      const vid = rng.uuid();
      const priceMinor = tpl.priceMinor + (optionValues.Size === "XL" ? 500 : 0);
      const costMinor = Math.round(priceMinor * tpl.costRatio);
      const isLow = lowStockProduct || rng.chance(0.05);
      // Demo guarantee (CLAUDE.md §10): one low-stock variant in four is out of stock everywhere and never
      // covered by an incoming purchase order, so "critical" products exist whatever the seed time.
      const isCritical = isLow && vi % 4 === 0;
      const v: V = { id: vid, productId, externalId: ext(), inventoryItemExternalId: ext(), sku: `${code}-${Object.values(optionValues).map((x) => x.slice(0, 3).toUpperCase()).join("-")}`, title: Object.values(optionValues).join(" / "), productTitle: title, priceMinor, costMinor, popularity: popularity * (0.7 + rng.next() * 0.6), optionValues, stockTotal: 0, isLow, isCritical };
      variants.push(v);
      ds.productVariants.push({ id: vid, tenantId, productId, externalId: v.externalId, inventoryItemExternalId: v.inventoryItemExternalId, sku: v.sku, barcode: String(8000000000000 + vi + i * 100), title: v.title, optionValues, priceMinor, compareAtMinor: rng.chance(0.2) ? Math.round(priceMinor * 1.25) : null, costMinor, averageCostMinor: Math.round(costMinor * (0.97 + rng.next() * 0.06)), weightGrams: isApparel ? rng.int(150, 900) : rng.int(300, 9000), packSize: isApparel ? null : rng.pick([null, 4, 6]), isActive: true, syncedAt: now });
      for (const loc of locations) {
        const available = isCritical ? 0 : isLow ? rng.int(0, 4) : rng.int(5, 90);
        const committed = rng.int(0, 3);
        v.stockTotal += available;
        ds.inventoryLevels.push(t({ variantId: vid, locationId: loc.id, available, committed, onHand: available + committed, syncedAt: now }));
      }
    });
  }
  const popularVariants = variants.map((v) => [v, v.popularity] as const);

  /* ---------- customers ---------- */
  const customerCount = Math.max(20, Math.round(cfg.orderCount * 0.42));
  interface C { id: string; externalId: string; firstName: string; lastName: string; email: string; phone: string; phoneE164: string | null; city: CityRow; street: string; acceptsMarketing: boolean; ordersCount: number; totalSpent: number; firstOrderAt: Date | null; lastOrderAt: Date | null; createdAt: Date }
  const customers: C[] = [];
  const usedEmails = new Set<string>();
  for (let i = 0; i < customerCount; i++) {
    const fn = rng.pick(first);
    const ln = rng.pick(last);
    const city = pickWeightedCity(rng, cities);
    let email = `${slug(fn)}.${slug(ln)}${rng.chance(0.4) ? rng.int(1, 99) : ""}@${rng.pick(["example.com", "mail.example", "demo.test"])}`;
    while (usedEmails.has(email)) email = `${slug(fn)}.${slug(ln)}${rng.int(100, 9999)}@example.com`;
    usedEmails.add(email);
    const phone = buildPhone(rng, city.country);
    customers.push({ id: rng.uuid(), externalId: ext(), firstName: fn, lastName: ln, email, phone, phoneE164: normalizePhone(phone, city.country), city, street: `${rng.pick(streets)} ${rng.int(1, 150)}`, acceptsMarketing: rng.chance(0.62), ordersCount: 0, totalSpent: 0, firstOrderAt: null, lastOrderAt: null, createdAt: addDays(now, -rng.int(0, 720)) });
  }

  /* ---------- campaigns ---------- */
  interface Camp { id: string; externalId: string; platform: "meta" | "google"; name: string; status: "active" | "paused" | "archived"; startedAt: Date; endedAt: Date | null; dailySpend: number; efficiency: number; productId: string | null; weight: number }
  const camps: Camp[] = [];
  const productList = [...productsById.values()];
  const mkCamp = (platform: "meta" | "google", i: number): Camp => {
    const product = rng.chance(0.75) ? rng.pick(productList) : null;
    const name = product
      ? `${rng.pick(CAMPAIGN_ADJECTIVES)} ${product.title} – ${rng.pick(platform === "meta" ? CAMPAIGN_SUFFIX.slice(0, 4) : CAMPAIGN_SUFFIX.slice(4))}`
      : `${rng.pick(CAMPAIGN_ADJECTIVES)} ${rng.pick(["Brand", "Catalog", "All products", "Bestsellers"])} – ${rng.pick(platform === "meta" ? CAMPAIGN_SUFFIX.slice(0, 4) : CAMPAIGN_SUFFIX.slice(4))}`;
    const startedAt = addDays(now, -rng.int(20, 365));
    const status = rng.weighted([["active", 65], ["paused", 25], ["archived", 10]] as const);
    const endedAt = status === "archived" ? addDays(startedAt, rng.int(20, 120)) : status === "paused" ? addDays(now, -rng.int(1, 40)) : null;
    const efficiency = rng.weighted([[0.4, 15], [0.8, 25], [1.2, 35], [1.8, 20], [2.6, 5]] as const); // low = losing money
    return { id: rng.uuid(), externalId: platform === "meta" ? `${120000000000 + i * 1313 + (platform === "meta" ? 0 : 1)}` : `${900000000 + i * 17}`, platform, name, status, startedAt, endedAt, dailySpend: rng.int(1500, 18000), efficiency, productId: product?.id ?? null, weight: 0.5 + rng.next() };
  };
  for (let i = 0; i < cfg.metaCampaigns; i++) camps.push(mkCamp("meta", i));
  for (let i = 0; i < cfg.googleCampaigns; i++) camps.push(mkCamp("google", 100 + i));
  for (const c of camps) {
    ds.campaigns.push({ id: c.id, tenantId, platform: c.platform, externalId: c.externalId, accountExternalId: c.platform === "meta" ? "act_demo" : "123-456-7890", name: c.name, status: c.status, objective: c.platform === "meta" ? "OUTCOME_SALES" : "SALES", dailyBudgetMinor: c.dailySpend, currency: cfg.currency, platformCreatedAt: c.startedAt, syncedAt: now });
    if (c.productId) ds.campaignProductLinks.push(t({ campaignId: c.id, productId: c.productId, isPrimary: true, source: rng.chance(0.6) ? "auto" : "manual" }));
    // daily metrics
    const end = c.endedAt ?? now;
    for (let d = new Date(iso(c.startedAt)); d <= end; d = addDays(d, 1)) {
      const season = seasonality[d.getUTCMonth()]!;
      const spend = Math.round(c.dailySpend * (0.55 + rng.next() * 0.9) * (0.8 + season * 0.2));
      const impressions = Math.round(spend / (c.platform === "meta" ? 6 : 11));
      const clicks = Math.round(impressions * (c.platform === "meta" ? 0.012 : 0.03) * (0.7 + rng.next() * 0.6));
      const purchases = Math.round(clicks * 0.025 * c.efficiency * (0.6 + rng.next() * 0.8));
      ds.adMetricsDaily.push(t({ campaignId: c.id, date: iso(d), spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.55), purchases, purchaseValueMinor: Math.round(purchases * (isApparel ? 7600 : 11200) * (0.8 + rng.next() * 0.4)) }));
    }
  }

  /* ---------- discounts ---------- */
  const discountRows = DISCOUNT_CODES.map((d, i) => ({ ...d, id: rng.uuid(), startsAt: addDays(now, -rng.int(30, 400)), endsAt: i % 4 === 0 ? addDays(now, rng.int(-10, 60)) : null, used: 0 }));
  const poolId = rng.uuid();
  const poolCodes: { id: string; code: string; used: boolean }[] = [];
  for (let i = 0; i < 200; i++) {
    const code = `${cfg.orderNumberPrefix}${rng.int(0, 0xffffff).toString(36).toUpperCase().padStart(5, "X")}${i.toString(36).toUpperCase()}`;
    poolCodes.push({ id: rng.uuid(), code, used: false });
  }
  ds.discountPools.push({ id: poolId, tenantId, title: isApparel ? "Codici personali win-back" : "Personal win-back codes", prefix: cfg.orderNumberPrefix, type: "percentage", value: 1500, targetSize: 200, status: "ready", externalId: ext(), startsAt: addDays(now, -40), endsAt: addDays(now, 50), createdBy: cfg.userIds[0] ?? null });

  /* ---------- state rules ---------- */
  const rules: StateRule[] = [
    ...defaultStateRules(),
    isApparel
      ? { id: "verify-address", name: "Tag verify-address needs review", priority: 50, conditions: { tagsAny: ["verify-address"] }, resultStatus: "pending_review", isActive: true }
      : { id: "wholesale-hold", name: "Wholesale orders wait for approval", priority: 50, conditions: { tagsAny: ["wholesale"] }, resultStatus: "on_hold", isActive: true },
    { id: "bank-transfer-wait", name: "Bank transfers wait for payment", priority: 150, conditions: { paymentMethods: ["bank_transfer"], paymentStatuses: ["pending"] }, resultStatus: "pending_review", isActive: true },
    ...(isApparel ? [{ id: "cod-confirmed-tag", name: "Tag confermato confirms a COD order", priority: 60, conditions: { paymentMethods: ["cod"], tagsAny: ["confermato"] }, resultStatus: "confirmed", isActive: true } as StateRule] : []),
  ];
  const ruleIdMap = new Map<string, string>();
  for (const r of rules) {
    const id = rng.uuid();
    ruleIdMap.set(r.id, id);
    ds.stateRules.push({ id, tenantId, name: r.name, priority: r.priority, conditions: r.conditions, resultStatus: r.resultStatus, isActive: r.isActive });
  }
  const dbRules: StateRule[] = rules.map((r) => ({ ...r, id: ruleIdMap.get(r.id)! }));

  /* ---------- suppliers ---------- */
  const suppliers = cfg.supplierNames.map((name, i) => t({ name, payeeName: `${name} S.r.l.`.replace("S.r.l.", isApparel ? "S.r.l." : "LLC"), email: `orders@${slug(name)}.example`, phone: buildPhone(rng, cfg.country), country: isApparel ? ["IT", "PT", "TR", "IT"][i % 4] : ["US", "VN", "IN"][i % 3], currency: cfg.currency, leadTimeDays: rng.int(14, 60), notes: null, isActive: true }));
  ds.suppliers.push(...suppliers);

  /* ---------- orders ---------- */
  const mappingDefaults: [string, ShipmentStatus, boolean, boolean][] = [["label_printed", "label_created", false, false], ["confirmed", "label_created", false, false], ["in_transit", "in_transit", false, false], ["out_for_delivery", "out_for_delivery", false, false], ["attempted_delivery", "attempted", true, false], ["delivered", "delivered", false, true], ["failure", "failed", true, true], ["ready_for_pickup", "out_for_delivery", false, false]];
  for (const [externalStatus, canonical, isException, isFinal] of mappingDefaults) ds.shipmentStatusMappings.push(t({ source: "shopify", externalStatus, canonicalStatus: canonical, isException, isFinal }));

  const userIds = cfg.userIds;
  const sysEvent = (orderId: string, type: string, at: Date, extra: Row = {}) => ds.orderEvents.push(t({ orderId, type, actorType: "system", actorUserId: null, diff: {}, metadata: {}, createdAt: at, ...extra }));
  let orderNumber = 1000;
  // ~1.2% of orders land in the last 48 hours so the demo always has fresh work (new, fulfilling, pending review).
  const recentCount = Math.max(5, Math.round(cfg.orderCount * 0.012));
  const placedAts = Array.from({ length: cfg.orderCount }, (_, i) => (i < recentCount ? new Date(now.getTime() - rng.next() * 48 * 36e5) : samplePlacedAt(rng, now, seasonality))).sort((a, b) => a.getTime() - b.getTime());
  const campaignWeights = camps.map((c) => [c, c.weight] as const);
  const openOrdersForBackorder: { orderId: string; lineId: string; variant: V; qty: number }[] = [];
  let returnNumber = 0;
  const reasons = isApparel ? RETURN_REASONS_IT : RETURN_REASONS_EN;
  ds.returnReasons.push(...reasons.map((r, i) => t({ code: r.code, label: r.label, defaultFault: r.fault, sortOrder: i, isActive: true })));
  let lastDuplicateSource: { customer: C; variant: V; placedAt: Date } | null = null;

  for (let i = 0; i < cfg.orderCount; i++) {
    const placedAt = placedAts[i]!;
    const ageDays = (now.getTime() - placedAt.getTime()) / DAY;
    // customer: skewed so some customers repeat often; occasionally a deliberate duplicate
    let customer: C;
    let dupOf: typeof lastDuplicateSource = null;
    if (lastDuplicateSource && placedAt.getTime() - lastDuplicateSource.placedAt.getTime() < 2 * DAY && rng.chance(0.5)) {
      customer = lastDuplicateSource.customer;
      dupOf = lastDuplicateSource;
      lastDuplicateSource = null;
    } else {
      customer = customers[Math.floor(Math.pow(rng.next(), 1.7) * customers.length)]!;
    }
    const orderId = rng.uuid();
    orderNumber += rng.int(1, 2);
    const lineCount = rng.weighted([[1, 58], [2, 27], [3, 11], [4, 4]] as const);
    const chosen: V[] = dupOf ? [dupOf.variant] : [];
    while (chosen.length < lineCount) {
      const v = rng.weighted(popularVariants);
      if (!chosen.includes(v)) chosen.push(v);
    }
    if (!dupOf && rng.chance(0.006)) lastDuplicateSource = { customer, variant: chosen[0]!, placedAt };

    const lines = chosen.map((v, li) => {
      const quantity = rng.weighted([[1, 86], [2, 12], [3, 2]] as const);
      return { id: rng.uuid(), v, quantity, unitPriceMinor: v.priceMinor, totalMinor: v.priceMinor * quantity, externalId: `${ext()}-${li}` };
    });
    const subtotal = lines.reduce((s, l) => s + l.totalMinor, 0);
    // discount
    let discountMinor = 0;
    let discountCode: { code: string; type: string; poolCodeIdx?: number; idx?: number } | null = null;
    if (rng.chance(0.22)) {
      if (rng.chance(0.12)) {
        const idx = poolCodes.findIndex((c) => !c.used);
        if (idx >= 0) {
          poolCodes[idx]!.used = true;
          discountMinor = Math.round(subtotal * 0.15);
          discountCode = { code: poolCodes[idx]!.code, type: "percentage", poolCodeIdx: idx };
        }
      } else {
        const idx = rng.int(0, discountRows.length - 1);
        const d = discountRows[idx]!;
        discountMinor = d.type === "percentage" ? Math.round((subtotal * d.value) / 10000) : d.type === "fixed_amount" ? Math.min(d.value, subtotal) : 0;
        d.used++;
        discountCode = { code: d.code, type: d.type, idx };
      }
    }
    const shippingMinor = discountCode?.type === "free_shipping" ? 0 : subtotal - discountMinor >= (isApparel ? 9000 : 15000) ? 0 : isApparel ? 590 : 895;
    const taxRateBps = isApparel ? (customer.city.country === "IT" ? 2200 : customer.city.country === "DE" ? 1900 : customer.city.country === "FR" ? 2000 : 2100) : 0;
    const taxMinor = isApparel ? Math.round(((subtotal - discountMinor) * taxRateBps) / (10000 + taxRateBps)) : Math.round(((subtotal - discountMinor) * 700) / 10000);
    const totalMinor = subtotal - discountMinor + shippingMinor + (isApparel ? 0 : taxMinor);

    // payment
    const gateway = isApparel
      ? rng.weighted([["shopify_payments", 52], ["paypal", 20], ["klarna", 8], ["bank_deposit", 5], ["cash_on_delivery", Math.round(cfg.codShare * 100)], ["apple_pay", 5]] as const)
      : rng.weighted([["shopify_payments", 58], ["paypal", 20], ["shop_pay", 10], ["afterpay", 9], ["gift_card", 3]] as const);
    const paymentMethod: PaymentMethod = gateway === "cash_on_delivery" ? "cod" : gateway === "bank_deposit" ? "bank_transfer" : gateway === "paypal" || gateway === "apple_pay" || gateway === "shop_pay" ? "wallet" : gateway === "klarna" || gateway === "afterpay" ? "bnpl" : gateway === "gift_card" ? "other" : "card";

    // lifecycle
    const cancelled = rng.chance(cfg.cancelRate) && ageDays > 0.2;
    const cancelledAt = cancelled ? addHours(placedAt, rng.int(1, 60)) : null;
    let fulfilledAt: Date | null = null;
    let shipmentStatus: ShipmentStatus | null = null;
    let deliveredAt: Date | null = null;
    let shipmentException = false;
    let partialFulfilment = false;
    const paysLater = paymentMethod === "cod" || paymentMethod === "bank_transfer";
    let paymentStatus: PaymentStatus = paysLater ? "pending" : "paid";
    if (cancelled) {
      paymentStatus = paysLater ? "voided" : "refunded";
    } else {
      const confirmDelayH = paysLater ? rng.int(4, 48) : rng.int(0, 6);
      const shipDelayH = confirmDelayH + rng.int(6, 60);
      const transitDays = (isApparel ? rng.int(1, 4) : rng.int(2, 6)) + (customer.city.country !== cfg.country ? 2 : 0);
      if (ageDays * 24 >= shipDelayH) {
        fulfilledAt = addHours(placedAt, shipDelayH);
        const deliveryAt = addDays(fulfilledAt, transitDays);
        if (deliveryAt <= now) {
          const outcome = rng.weighted([["delivered", 955], ["stuck", 15], ["exception", 12], ["returned_to_sender", paymentMethod === "cod" ? 25 : 6], ["failed", 4]] as const);
          if (outcome === "delivered") {
            shipmentStatus = "delivered";
            deliveredAt = deliveryAt;
            if (paysLater) paymentStatus = "paid";
          } else if (outcome === "stuck") shipmentStatus = "in_transit";
          else if (outcome === "exception") {
            shipmentStatus = "exception";
            shipmentException = true;
          } else if (outcome === "returned_to_sender") {
            shipmentStatus = "returned";
            if (paysLater) paymentStatus = "voided";
          } else shipmentStatus = "failed";
        } else {
          const progress = (now.getTime() - fulfilledAt.getTime()) / (deliveryAt.getTime() - fulfilledAt.getTime());
          shipmentStatus = progress < 0.15 ? "label_created" : progress < 0.8 ? "in_transit" : "out_for_delivery";
        }
        if (paymentMethod === "bank_transfer") paymentStatus = "paid";
      } else if (ageDays * 24 >= confirmDelayH) {
        if (paymentMethod === "bank_transfer" && rng.chance(0.7)) paymentStatus = "paid";
        if (lines.length > 1 && rng.chance(0.25)) partialFulfilment = true;
      }
    }
    // returns (apparel 12%, home 7%) on delivered orders older than 3 days
    let returnedFraction = 0;
    let refundedMinor = 0;
    let returnInfo: { status: string; reason: (typeof reasons)[number]; resolution: "refund" | "exchange" | "voucher"; requestedAt: Date; lines: typeof lines; fraction: number } | null = null;
    if (shipmentStatus === "delivered" && deliveredAt && (now.getTime() - deliveredAt.getTime()) / DAY > 3 && rng.chance(cfg.returnRate)) {
      const retLines = lines.length > 1 && rng.chance(0.5) ? lines.slice(0, 1) : lines;
      const fraction = retLines.reduce((s, l) => s + l.totalMinor, 0) / subtotal;
      const requestedAt = addDays(deliveredAt, rng.int(1, 12));
      const retAge = (now.getTime() - requestedAt.getTime()) / DAY;
      const status = retAge < 2 ? "requested" : retAge < 5 ? rng.pick(["approved", "requested", "rejected"]) : retAge < 10 ? rng.pick(["received", "approved", "inspected"]) : rng.weighted([["refunded", 70], ["exchanged", 12], ["voucher_issued", 10], ["rejected", 8]] as const);
      const resolution = status === "exchanged" ? "exchange" : status === "voucher_issued" ? "voucher" : "refund";
      returnInfo = { status, reason: rng.weighted(reasons.map((r, idx) => [r, idx === 0 ? 40 : idx === 1 ? 25 : 8] as const)), resolution, requestedAt, lines: retLines, fraction };
      if (status === "refunded" || status === "exchanged" || status === "voucher_issued") {
        returnedFraction = fraction;
        if (status === "refunded") {
          refundedMinor = Math.round(retLines.reduce((s, l) => s + l.totalMinor, 0) * (1 - discountMinor / Math.max(subtotal, 1)));
          paymentStatus = fraction >= 0.999 ? "refunded" : "partially_refunded";
        }
      }
    }
    const platformTags: string[] = [];
    if (customer.ordersCount >= 3) platformTags.push("repeat");
    if (rng.chance(0.04)) platformTags.push("vip");
    if (!isApparel && rng.chance(0.03)) platformTags.push("wholesale");
    if (isApparel && rng.chance(0.02)) platformTags.push("verify-address");
    if (paymentMethod === "cod") platformTags.push("cod");
    const financialStatusRaw = paymentStatus === "paid" ? "paid" : paymentStatus === "pending" ? (paymentMethod === "card" ? "authorized" : "pending") : paymentStatus;
    const fulfillmentStatusRaw = fulfilledAt ? "fulfilled" : partialFulfilment ? "partial" : null;
    const derived = deriveOrderStatus({ platformTags, paymentMethod, paymentStatus, financialStatusRaw, fulfillmentStatusRaw, cancelledAt, placedAt, shipmentStatus, returnedFraction, manualStatus: null, now }, dbRules);
    let status: OrderStatus = derived.status;
    let statusSource = "rules";
    let holdReason: string | null = null;
    if (status === "new" && ageDays > 0.5 && rng.chance(0.3) && !cancelled) {
      status = "confirmed";
      statusSource = "manual";
    }
    if (status === "on_hold") holdReason = "awaiting_approval";
    const shippingAddress = { name: `${customer.firstName} ${customer.lastName}`, address1: customer.street, address2: null, city: customer.city.city, province: customer.city.province ?? null, zip: customer.city.zip, country: customer.city.country, phone: customer.phone };
    const assignedTo = !cancelled && !fulfilledAt && rng.chance(0.4) && userIds.length ? rng.pick(userIds) : null;
    const customerName = `${customer.firstName} ${customer.lastName}`;
    // attribution
    const attributed = rng.chance(0.58);
    let campaign: Camp | null = null;
    let channel = "direct";
    let utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null } = { source: null, medium: null, campaign: null, content: null };
    const clickIds: Record<string, string> = {};
    if (attributed && camps.length) {
      campaign = rng.weighted(campaignWeights);
      if (campaign.platform === "meta") {
        utm = { source: rng.pick(["facebook", "instagram", "fb"]), medium: "paid", campaign: campaign.externalId, content: `ad_${rng.int(100, 999)}` };
        clickIds.fbclid = `IwAR${rng.int(1e9, 9e9).toString(36)}`;
        channel = "meta_ads";
      } else {
        utm = { source: "google", medium: "cpc", campaign: campaign.externalId, content: null };
        clickIds.gclid = `Cj0K${rng.int(1e9, 9e9).toString(36)}`;
        channel = "google_ads";
      }
    } else {
      const c = rng.weighted([["direct", 40], ["google_organic", 22], ["email", 15], ["meta_organic", 10], ["referral", 8], ["unknown", 5]] as const);
      channel = c;
      if (c === "email") utm = { source: "newsletter", medium: "email", campaign: `weekly-${rng.int(1, 40)}`, content: null };
      if (c === "google_organic") utm = { source: "google", medium: "organic", campaign: null, content: null };
      if (c === "meta_organic") utm = { source: "instagram", medium: "social", campaign: null, content: null };
    }
    const landingSite = utm.source ? `/products/${slug(lines[0]!.v.productTitle)}?utm_source=${utm.source}&utm_medium=${utm.medium}${utm.campaign ? `&utm_campaign=${utm.campaign}` : ""}${clickIds.fbclid ? `&fbclid=${clickIds.fbclid}` : ""}${clickIds.gclid ? `&gclid=${clickIds.gclid}` : ""}` : "/";

    // Northwind speaks to its store through tags (the reference vocabulary): the COD add-on reads and writes them.
    if (isApparel && paymentMethod === "cod") {
      if (status === "new" || status === "pending_review") platformTags.push(rng.chance(0.15) ? "da chiamare" : "da confermare");
      else if (status === "confirmed" || status === "fulfilling" || status === "shipped" || status === "delivered") platformTags.push("confermato");
      else if (status === "cancelled") platformTags.push("annullato");
    }
    ds.orders.push({
      id: orderId, tenantId, externalId: String(5000000000 + orderNumber), orderNumber, name: `#${cfg.orderNumberPrefix}${orderNumber}`, customerId: customer.id, customerName, email: customer.email, emailNormalized: normalizeEmail(customer.email), phone: customer.phone, phoneE164: customer.phoneE164,
      status, statusSource, statusReason: statusSource === "manual" ? "manual" : derived.reason, statusChangedAt: fulfilledAt ?? cancelledAt ?? placedAt, manualStatus: statusSource === "manual" ? status : null,
      paymentMethod, paymentStatus, paymentGateways: [gateway], financialStatusRaw, fulfillmentStatusRaw, platformTags, currency: cfg.currency,
      subtotalMinor: subtotal, discountMinor, shippingMinor, taxMinor, totalMinor, refundedMinor, returnedFraction: Math.round(returnedFraction * 10000),
      shippingAddress, billingAddress: shippingAddress, shippingCountry: customer.city.country, shippingZip: customer.city.zip, shippingCity: customer.city.city, addressKey: addressKey({ address1: customer.street, zip: customer.city.zip, city: customer.city.city }), nameZipKey: nameZipKey(customerName, customer.city.zip),
      note: rng.chance(0.06) ? (isApparel ? "Citofono rotto, chiamare all'arrivo" : "Leave at the side door, please") : null, noteAttributes: utm.source ? [{ name: "utm_source", value: utm.source }, { name: "utm_campaign", value: utm.campaign ?? "" }] : [],
      landingSite, referringSite: channel === "referral" ? "https://blog.example/best-picks" : channel === "google_organic" ? "https://www.google.com/" : null, sourceChannel: rng.chance(0.03) ? "pos" : rng.chance(0.03) ? "draft" : "web", isTest: false,
      placedAt, cancelledAt, cancelReason: cancelled ? rng.pick(["customer", "inventory", "fraud", "other"]) : null, closedAt: deliveredAt, assignedTo, holdReason, platformUpdatedAt: deliveredAt ?? fulfilledAt ?? cancelledAt ?? placedAt, syncedAt: now,
    });
    for (const l of lines) ds.orderLines.push({ id: l.id, tenantId, orderId, externalId: l.externalId, productId: l.v.productId, variantId: l.v.id, sku: l.v.sku, title: l.v.productTitle, variantTitle: l.v.title, quantity: l.quantity, currentQuantity: cancelled ? 0 : l.quantity, unitPriceMinor: l.unitPriceMinor, discountMinor: Math.round((discountMinor * l.totalMinor) / Math.max(subtotal, 1)), totalMinor: l.totalMinor, unitCostMinor: l.v.costMinor, isAncillary: false });
    if (discountCode) {
      ds.orderDiscounts.push(t({ orderId, code: discountCode.code, type: discountCode.type, amountMinor: discountMinor }));
    }
    ds.orderAttribution.push(t({ orderId, utmSource: utm.source, utmMedium: utm.medium, utmCampaign: utm.campaign, utmContent: utm.content, utmTerm: null, clickIds, campaignId: campaign?.id ?? null, channel, source: "seed", capturedAt: placedAt }));
    // events
    sysEvent(orderId, "imported", placedAt, { actorType: "integration", metadata: { source: "shopify", gateway } });
    if (statusSource === "manual") ds.orderEvents.push(t({ orderId, type: "status_changed", actorType: "user", actorUserId: userIds.length ? rng.pick(userIds) : null, diff: { status: { from: "new", to: "confirmed" } }, metadata: { source: "manual" }, createdAt: addHours(placedAt, rng.int(1, 12)) }));
    if (cancelledAt) sysEvent(orderId, "cancelled", cancelledAt, { actorType: rng.chance(0.5) ? "user" : "integration", actorUserId: rng.chance(0.5) && userIds.length ? rng.pick(userIds) : null, diff: { status: { from: "confirmed", to: "cancelled" } } });
    if (fulfilledAt) sysEvent(orderId, "fulfillment_updated", fulfilledAt, { actorType: "integration", diff: { fulfillmentStatusRaw: { from: null, to: "fulfilled" } } });
    if (deliveredAt) sysEvent(orderId, "shipment_updated", deliveredAt, { actorType: "integration", diff: { shipmentStatus: { from: "in_transit", to: "delivered" } } });
    if (assignedTo) ds.orderEvents.push(t({ orderId, type: "assigned", actorType: "user", actorUserId: userIds[0] ?? null, diff: { assignedTo: { from: null, to: assignedTo } }, metadata: {}, createdAt: addHours(placedAt, 1) }));
    if (rng.chance(0.025) && userIds.length >= 2) {
      const author = rng.pick(userIds);
      const mentioned = rng.pick(userIds.filter((u) => u !== author));
      ds.orderNotes.push(t({ orderId, authorId: author, body: isApparel ? `@[utente](${mentioned}) puoi controllare l'indirizzo prima della spedizione?` : `@[teammate](${mentioned}) can you double-check the address before shipping?`, mentions: [mentioned], createdAt: addHours(placedAt, rng.int(1, 30)) }));
      ds.orderEvents.push(t({ orderId, type: "note_added", actorType: "user", actorUserId: author, diff: {}, metadata: { mentions: 1 }, createdAt: addHours(placedAt, rng.int(1, 30)) }));
    }
    // shipment
    if (fulfilledAt && shipmentStatus) {
      const shipmentId = rng.uuid();
      const carrier = rng.pick(carriers);
      const tracking = `${carrier.slice(0, 2).toUpperCase()}${rng.int(100000000, 999999999)}${cfg.country}`;
      const lastEventAt = deliveredAt ?? addHours(fulfilledAt, rng.int(12, 96));
      ds.shipments.push({ id: shipmentId, tenantId, orderId, externalId: ext(), trackingNumber: tracking, trackingUrl: `https://track.example/${tracking}`, carrier, status: shipmentStatus, sourceOfTruth: "shopify", exceptionReason: shipmentException ? "delivery_error" : null, exceptionSince: shipmentException ? lastEventAt : null, isLocked: false, shippedAt: fulfilledAt, deliveredAt, estimatedDelivery: addDays(fulfilledAt, 4), lastEventAt });
      ds.shipmentSourceStates.push(t({ shipmentId, source: "shopify", status: shipmentStatus, detail: null, externalStatus: shipmentStatus === "delivered" ? "delivered" : shipmentStatus === "exception" ? "attempted_delivery" : shipmentStatus, lastEventAt, raw: {} }));
      ds.shipmentEvents.push(t({ shipmentId, source: "shopify", status: "label_created", description: "Label created", location: String(locations[0]!.name), occurredAt: fulfilledAt }));
      if (shipmentStatus !== "label_created") ds.shipmentEvents.push(t({ shipmentId, source: "shopify", status: "in_transit", description: "In transit", location: rng.pick(["Hub", "Sorting center", customer.city.city]), occurredAt: addHours(fulfilledAt, rng.int(6, 30)) }));
      if (["out_for_delivery", "delivered", "exception", "returned", "failed"].includes(shipmentStatus)) ds.shipmentEvents.push(t({ shipmentId, source: "shopify", status: shipmentStatus === "delivered" ? "out_for_delivery" : shipmentStatus, description: shipmentStatus === "exception" ? "Delivery attempted, recipient absent" : shipmentStatus === "returned" ? "Returned to sender" : "Out for delivery", location: customer.city.city, occurredAt: addHours(lastEventAt, -3) }));
      if (deliveredAt) ds.shipmentEvents.push(t({ shipmentId, source: "shopify", status: "delivered", description: "Delivered", location: customer.city.city, occurredAt: deliveredAt }));
    }
    // return request
    if (returnInfo) {
      const rid = rng.uuid();
      returnNumber += 1;
      const proposed = returnInfo.lines.reduce((s, l) => s + l.totalMinor, 0);
      const closed = ["refunded", "exchanged", "voucher_issued", "rejected"].includes(returnInfo.status);
      const received = ["received", "inspected", "refunded", "exchanged", "voucher_issued"].includes(returnInfo.status);
      ds.returnRequests.push({ id: rid, tenantId, orderId, number: returnNumber, externalId: null, status: returnInfo.status, reasonCode: returnInfo.reason.code, resolution: returnInfo.resolution, fault: returnInfo.reason.fault, customerNote: null, staffNote: returnInfo.status === "rejected" ? "Outside the return window" : null, proposedAmountMinor: proposed, refundedAmountMinor: returnInfo.status === "refunded" ? refundedMinor : null, voucherCode: returnInfo.status === "voucher_issued" ? `${cfg.orderNumberPrefix}V${rng.int(1000, 9999)}` : null, exchangeOrderId: null, restockLocationId: received ? defaultLocation.id : null, outOfWindow: returnInfo.status === "rejected", requestedAt: returnInfo.requestedAt, approvedAt: returnInfo.status === "requested" || returnInfo.status === "rejected" ? null : addDays(returnInfo.requestedAt, 1), receivedAt: received ? addDays(returnInfo.requestedAt, 5) : null, closedAt: closed ? addDays(returnInfo.requestedAt, 8) : null, createdBy: null });
      for (const l of returnInfo.lines) {
        const restocked = received && returnInfo.reason.fault !== "merchant";
        ds.returnLines.push(t({ returnId: rid, orderLineId: l.id, quantity: l.quantity, unitAmountMinor: l.unitPriceMinor, inspectionOutcome: received ? (returnInfo.reason.fault === "merchant" ? "damaged" : "intact") : null, inspectionAmountMinor: received ? l.totalMinor : null, restocked }));
        if (restocked) ds.inventoryMovements.push(t({ variantId: l.v.id, locationId: defaultLocation.id, delta: l.quantity, reason: "return_restock", referenceType: "return", referenceId: rid, actorUserId: null, note: null, createdAt: addDays(returnInfo.requestedAt, 5) }));
      }
      sysEvent(orderId, "return_requested", returnInfo.requestedAt, { metadata: { returnId: rid, reason: returnInfo.reason.code } });
    }
    // backorder candidates: open orders with lines on low-stock variants
    if (!cancelled && !fulfilledAt && status !== "on_hold") for (const l of lines) if (l.v.isLow && l.v.stockTotal < l.quantity + 2) openOrdersForBackorder.push({ orderId, lineId: l.id, variant: l.v, qty: l.quantity });
    // customer aggregates
    if (!cancelled) {
      customer.ordersCount += 1;
      customer.totalSpent += totalMinor - refundedMinor;
      customer.firstOrderAt = customer.firstOrderAt ?? placedAt;
      customer.lastOrderAt = placedAt;
    }
  }

  // Guarantee coverage of low-probability tables at small scales (isolation suite).
  if (ds.orderNotes.length === 0 && ds.orders.length && userIds.length >= 1) {
    const o = ds.orders[0]!;
    ds.orderNotes.push(t({ orderId: o.id, authorId: userIds[0]!, body: isApparel ? "Controllare indirizzo." : "Check the address.", mentions: [], createdAt: now }));
  }

  /* ---------- customers rows ---------- */
  for (const c of customers) ds.customers.push({ id: c.id, tenantId, externalId: c.externalId, email: c.email, emailNormalized: normalizeEmail(c.email), phone: c.phone, phoneE164: c.phoneE164, firstName: c.firstName, lastName: c.lastName, country: c.city.country, city: c.city.city, zip: c.city.zip, acceptsMarketing: c.acceptsMarketing, tags: c.ordersCount >= 3 ? ["repeat"] : [], ordersCount: c.ordersCount, totalSpentMinor: c.totalSpent, firstOrderAt: c.firstOrderAt, lastOrderAt: c.lastOrderAt, platformCreatedAt: c.createdAt, syncedAt: now });

  /* ---------- discounts rows ---------- */
  for (const d of discountRows) ds.discounts.push({ id: d.id, tenantId, externalId: ext(), poolId: null, code: d.code, title: d.title, type: d.type, value: d.value, minimumAmountMinor: d.code === "FREESHIP" ? 5000 : null, usageLimit: d.code === "VIP25" ? 300 : null, usedCount: d.used, startsAt: d.startsAt, endsAt: d.endsAt, isActive: !d.endsAt || d.endsAt > now, source: "platform", syncedAt: now });
  for (const c of poolCodes) ds.discounts.push({ id: c.id, tenantId, externalId: null, poolId, code: c.code, title: null, type: "percentage", value: 1500, minimumAmountMinor: null, usageLimit: 1, usedCount: c.used ? 1 : 0, startsAt: addDays(now, -40), endsAt: addDays(now, 50), isActive: !c.used, source: "keel", syncedAt: null });

  /* ---------- purchasing ---------- */
  const poCount = isApparel ? 22 : 9;
  const inTransitLines: { lineId: string; variant: V }[] = [];
  for (let i = 0; i < poCount; i++) {
    const supplier = suppliers[i % suppliers.length]!;
    const status = rng.weighted([["draft", 8], ["sent", 10], ["confirmed", 15], ["in_transit", 20], ["partially_received", 8], ["received", 32], ["cancelled", 7]] as const);
    const orderedAt = status === "draft" ? addDays(now, -rng.int(0, 5)) : addDays(now, -rng.int(5, 300));
    const expectedAt = ["confirmed", "in_transit", "sent"].includes(status) ? addDays(now, rng.int(3, 45)) : addDays(orderedAt, rng.int(20, 50));
    const receivedAt = status === "received" || status === "partially_received" ? addDays(orderedAt, rng.int(15, 45)) : null;
    const poId = rng.uuid();
    const number = `PO-${orderedAt.getUTCFullYear()}${String(orderedAt.getUTCMonth() + 1).padStart(2, "0")}-${String(i + 1).padStart(3, "0")}`;
    const lineVariants = rng.shuffle(variants).slice(0, rng.int(3, 10));
    // prefer low-stock variants for incoming POs so coverage looks right
    // Incoming purchase orders cover only half of the low-stock variants, so the demo always has products at risk with nothing on the way (CLAUDE.md §10).
    if (status === "in_transit" || status === "confirmed") for (const [vi, v] of variants.entries()) if (v.isLow && !v.isCritical && vi % 2 !== 0 && rng.chance(0.3) && !lineVariants.includes(v)) lineVariants.push(v);
    let total = 0;
    for (const v of lineVariants) {
      const quantity = rng.int(10, 120);
      const unitCost = Math.round(v.costMinor * (0.95 + rng.next() * 0.1));
      const receivedQuantity = status === "received" ? quantity : status === "partially_received" ? Math.round(quantity * rng.next()) : 0;
      total += quantity * unitCost;
      const lineId = rng.uuid();
      ds.purchaseOrderLines.push({ id: lineId, tenantId, purchaseOrderId: poId, variantId: v.id, description: null, quantity, receivedQuantity, unitCostMinor: unitCost });
      if (status === "in_transit" || status === "confirmed") inTransitLines.push({ lineId, variant: v });
      if (receivedQuantity > 0) ds.inventoryMovements.push(t({ variantId: v.id, locationId: defaultLocation.id, delta: receivedQuantity, reason: "receipt", referenceType: "purchase_order", referenceId: poId, actorUserId: userIds[0] ?? null, note: number, createdAt: receivedAt }));
    }
    ds.purchaseOrders.push({ id: poId, tenantId, supplierId: supplier.id, number, status, currency: cfg.currency, destinationLocationId: defaultLocation.id, orderedAt: status === "draft" ? null : orderedAt, expectedAt, sentAt: status === "draft" ? null : orderedAt, confirmedAt: ["confirmed", "in_transit", "partially_received", "received"].includes(status) ? addDays(orderedAt, 1) : null, receivedAt, cancelledAt: status === "cancelled" ? addDays(orderedAt, 2) : null, totalMinor: total, notes: null, createdBy: userIds[0] ?? null });
    if (status === "received" && rng.chance(0.7)) ds.supplierPayments.push(t({ supplierId: supplier.id, purchaseOrderId: poId, amountMinor: total, paidAt: addDays(receivedAt!, rng.int(5, 40)), method: "bank_transfer", note: number }));
    else if (status === "received" && rng.chance(0.5)) ds.supplierPayments.push(t({ supplierId: supplier.id, purchaseOrderId: poId, amountMinor: Math.round(total / 2), paidAt: addDays(receivedAt!, 10), method: "bank_transfer", note: `${number} deposit` }));
  }
  if (ds.supplierPayments.length === 0 && suppliers[0]) ds.supplierPayments.push(t({ supplierId: suppliers[0].id, purchaseOrderId: null, amountMinor: 120000, paidAt: addDays(now, -30), method: "bank_transfer", note: "Deposit" }));
  // backorders
  const seenBackorderOrders = new Set<string>();
  for (const b of openOrdersForBackorder.slice(0, 40)) {
    const cover = inTransitLines.find((l) => l.variant.id === b.variant.id);
    if (seenBackorderOrders.has(b.lineId)) continue;
    seenBackorderOrders.add(b.lineId);
    ds.backorders.push(t({ orderLineId: b.lineId, orderId: b.orderId, variantId: b.variant.id, quantity: b.qty, purchaseOrderLineId: cover?.lineId ?? null, status: cover ? "covered" : "pending", resolvedAt: null }));
  }
  if (ds.backorders.length === 0) {
    const anyLine = ds.orderLines[0]!;
    ds.backorders.push(t({ orderLineId: anyLine.id, orderId: anyLine.orderId, variantId: anyLine.variantId, quantity: 1, purchaseOrderLineId: null, status: "pending", resolvedAt: null }));
  }

  /* ---------- cost settings ---------- */
  for (let m = 12; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    ds.costSettings.push(t({ kind: "shipping_per_order", label: null, amountMinor: (isApparel ? 620 : 890) + (m % 3) * 15, validFrom: iso(d), validTo: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) }));
  }
  ds.costSettings.push(t({ kind: "fixed_monthly", label: isApparel ? "Software e servizi" : "Software & services", amountMinor: isApparel ? 180000 : 95000, validFrom: iso(addDays(now, -400)), validTo: null }));
  // period costs: estimate every month, actual once the month is closed (±8 %); the current month has estimates only
  const fixedLines: [string, number][] = isApparel ? [["Software e servizi", 180000], ["Personale", 1250000], ["Agenzia e consulenti", 240000], ["Affitto e utenze", 320000]] : [["Software & services", 95000], ["Payroll", 680000], ["Agency", 150000], ["Rent & utilities", 210000]];
  for (let m = 12; m >= -1; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const closed = m >= 1;
    for (const [label, estimate] of fixedLines) ds.periodCosts.push(t({ period, kind: "fixed", label, estimateMinor: estimate, actualMinor: closed ? Math.round(estimate * (0.92 + rng.next() * 0.16)) : null, note: null }));
    const shippingEstimate = Math.round((isApparel ? 1250 : 500) * (0.8 + rng.next() * 0.4) * (isApparel ? 620 : 890));
    ds.periodCosts.push(t({ period, kind: "shipping", label: "", estimateMinor: shippingEstimate, actualMinor: closed ? Math.round(shippingEstimate * (0.9 + rng.next() * 0.2)) : null, note: null }));
  }

  /* ---------- segments ---------- */
  const segDefs = [
    { name: isApparel ? "Clienti ricorrenti" : "Repeat customers", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] }, holdout: 10, test: (c: C) => c.ordersCount >= 2 },
    { name: isApparel ? "Alto valore, inattivi 90gg" : "High value, inactive 90d", rules: { match: "all", conditions: [{ field: "total_spent", op: "gte", value: isApparel ? 25000 : 40000 }, { field: "days_since_last_order", op: "gte", value: 90 }] }, holdout: 20, test: (c: C) => c.totalSpent >= (isApparel ? 25000 : 40000) && !!c.lastOrderAt && (now.getTime() - c.lastOrderAt.getTime()) / DAY >= 90 },
    { name: isApparel ? "Nuovi con consenso marketing" : "New with marketing consent", rules: { match: "all", conditions: [{ field: "orders_count", op: "eq", value: 1 }, { field: "accepts_marketing", op: "eq", value: true }, { match: "any", conditions: [{ field: "country", op: "in", value: [cfg.country] }, { field: "days_since_first_order", op: "lte", value: 60 }] }] }, holdout: 0, test: (c: C) => c.ordersCount === 1 && c.acceptsMarketing },
  ];
  for (const s of segDefs) {
    const segId = rng.uuid();
    const members = customers.filter(s.test);
    ds.segments.push({ id: segId, tenantId, name: s.name, description: null, rules: s.rules, holdoutPercentage: s.holdout, holdoutSalt: "holdout", lastCount: members.length, lastEvaluatedAt: now, createdBy: userIds[0] ?? null });
    for (const m of members) ds.segmentMemberships.push(t({ segmentId: segId, customerId: m.id, groupName: s.holdout > 0 && rng.next() * 100 < s.holdout ? "holdout" : "treated", evaluatedAt: now }));
  }

  /* ---------- integrations, health, runs, webhooks ---------- */
  const providers: [string, string, string][] = [["shopify", `${cfg.key}-demo.myshopify.com`, `${cfg.key} demo store`], ["meta", "act_demo", `${cfg.key} Meta account`], ["google", "123-456-7890", `${cfg.key} Google Ads`]];
  for (const [provider, accId, accName] of providers) {
    ds.integrations.push(t({ provider, status: "connected", mode: "mock", externalAccountId: accId, externalAccountName: accName, credentialsEncrypted: null, config: provider === "shopify" ? { webhooksRegistered: true, apiVersion: "2025-07" } : {}, lastSyncAt: addHours(now, -1), lastSuccessAt: addHours(now, -1), lastError: null }));
    ds.integrationHealth.push(t({ source: provider, status: "ok", lastSuccessAt: addHours(now, -1), lastAttemptAt: addHours(now, -1), lastMetricDate: iso(addDays(now, -1)), consecutiveFailures: 0, rowsWrittenLast: provider === "shopify" ? 42 : 310, freshnessMinutes: provider === "shopify" ? 30 : provider === "meta" ? 60 : 720, lastError: null, meta: {} }));
    ds.syncRuns.push(t({ provider, objectType: provider === "shopify" ? "orders" : "metrics", kind: "delta", status: "success", cursor: {}, rowsWritten: 42, error: null, startedAt: addHours(now, -1), finishedAt: addHours(now, -0.98) }));
  }
  for (const [p, i] of [["messaging", 0], ["warehouse", 1], ["carrier", 2]] as const) ds.integrations.push(t({ provider: p, status: "not_connected", mode: "mock", externalAccountId: null, externalAccountName: null, credentialsEncrypted: null, config: {}, lastSyncAt: null, lastSuccessAt: null, lastError: i === 2 ? null : null }));
  const lastOrders = ds.orders.slice(-5);
  for (const o of lastOrders) ds.webhookEvents.push(t({ source: "shopify", topic: "orders/updated", externalId: String(o.externalId), sourceUpdatedAt: (o.platformUpdatedAt as Date).toISOString(), payload: { id: o.externalId, note: "seeded" }, status: "processed", attempts: 1, lastError: null, processedAt: now, receivedAt: addHours(now, -2) }));
  ds.webhookEvents.push(t({ source: "shopify", topic: "orders/updated", externalId: "5009999999", sourceUpdatedAt: now.toISOString(), payload: { id: "5009999999" }, status: "failed", attempts: 3, lastError: "statement timeout", processedAt: null, receivedAt: addHours(now, -5) }));

  /* ---------- notifications & audit ---------- */
  for (const u of userIds) {
    ds.notifications.push(t({ userId: u, type: "stock_low", severity: "warning", title: isApparel ? "3 varianti sotto la soglia di stock" : "3 variants below the stock threshold", body: null, link: "/inventory?risk=critical", metadata: {}, readAt: null }));
    ds.notifications.push(t({ userId: u, type: "integration_health", severity: "info", title: isApparel ? "Sync Shopify completato" : "Shopify sync completed", body: null, link: "/integrations", metadata: { source: "shopify" }, readAt: addHours(now, -3), createdAt: addHours(now, -4) }));
  }
  ds.auditLogs.push(t({ actorUserId: null, actorType: "system", action: "tenant.seeded", entityType: "tenant", entityId: tenantId, diff: {}, metadata: { orders: ds.orders.length } }));
  ds.auditLogs.push(t({ actorUserId: userIds[0] ?? null, actorType: "user", action: "integration.connected", entityType: "integration", entityId: "shopify", diff: { status: { from: "not_connected", to: "connected" } }, metadata: {}, createdAt: addDays(now, -200) }));

  return ds;
}
