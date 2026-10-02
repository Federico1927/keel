import { createRng, type Rng } from "@hullwise/integrations/rng";
import {
  AWAITING_STOCK_REASON,
  addressKey,
  defaultStateRules,
  deriveOrderStatus,
  nameZipKey,
  splitExact,
  normalizeEmail,
  normalizePhone,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
  type ShipmentStatus,
  type StateRule,
} from "@hullwise/core";
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
  /** Active add-ons: decide which add-on data the generator writes (e.g. segment control groups). */
  addons: readonly string[];
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
  touchpoints: Row[];
  adCreatives: Row[];
  adCreativeMetricsDaily: Row[];
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
  platformWrites: Row[];
  inventoryDrift: Row[];
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
/** Gamma(shape k, scale 1) by Marsaglia–Tsang; Box–Muller for the normal draw. */
function gammaSample(next: () => number, k: number): number {
  if (k < 1) return gammaSample(next, k + 1) * Math.pow(next(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    if (Math.log(1 - next()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/**
 * Who places each order, in time order, from a customer lifecycle: every customer is acquired at
 * some point (a third before the data window opens), buys at a personal rate and may drop out
 * after each purchase (rates Gamma-distributed, drop-out Beta-distributed: the textbook
 * buy-till-you-die story). The event sequence is mapped by rank onto the seasonal order dates, so
 * volume, seasonality and growth stay those of `samplePlacedAt`, while repeat buying, gaps and
 * churn look like a real store's. Deterministic for a seed.
 */
export function lifecycleCustomerSequence(seed: number, customerCount: number, orderCount: number, windowDays = 365): number[] {
  const simulate = (meanRatePerDay: number) => {
    const rng = createRng(seed);
    const events: { t: number; c: number }[] = [];
    for (let c = 0; c < customerCount; c++) {
      const lambda = (gammaSample(rng.next, 0.9) / 0.9) * meanRatePerDay;
      const g1 = gammaSample(rng.next, 1.6);
      const dropOut = g1 / (g1 + gammaSample(rng.next, 4.5));
      let t = windowDays * (rng.next() * 1.5 - 0.5);
      for (;;) {
        if (t >= 0 && t <= windowDays) events.push({ t, c });
        if (rng.next() < dropOut) break;
        t += -Math.log(1 - rng.next()) / lambda;
        if (t > windowDays) break;
      }
    }
    return events;
  };
  // the purchase rate that yields the requested number of orders (drop-out makes it non-linear)
  let rate = orderCount / (customerCount * windowDays);
  let events = simulate(rate);
  for (let i = 0; i < 6 && Math.abs(events.length - orderCount) > orderCount * 0.02; i++) {
    rate *= Math.pow(orderCount / Math.max(events.length, 1), 1.5);
    events = simulate(rate);
  }
  const rng = createRng(seed + 1);
  if (events.length > orderCount) events = rng.shuffle(events).slice(0, orderCount);
  while (events.length < orderCount) events.push({ t: rng.next() * windowDays, c: rng.int(0, customerCount - 1) });
  return events.sort((x, y) => x.t - y.t).map((e) => e.c);
}

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
    orders: [], orderLines: [], orderEvents: [], orderNotes: [], orderDiscounts: [], orderAttribution: [], shipments: [], shipmentSourceStates: [], shipmentEvents: [], shipmentStatusMappings: [], stateRules: [], costSettings: [], periodCosts: [], touchpoints: [], adCreatives: [], adCreativeMetricsDaily: [],
    returnReasons: [], returnRequests: [], returnLines: [], suppliers: [], purchaseOrders: [], purchaseOrderLines: [], supplierPayments: [], backorders: [], segments: [], segmentMemberships: [], notifications: [], integrations: [], integrationHealth: [], webhookEvents: [], syncRuns: [], platformWrites: [], inventoryDrift: [], auditLogs: [],
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
  // creatives: Meta campaigns get 3–6 ads named "FORMAT | HOOK | ANGLE", Google campaigns 2 text ads
  interface Creative { id: string; externalId: string; campaignId: string; format: string; weight: number; ctrFactor: number; fatigues: boolean }
  const creativesByCampaign = new Map<string, Creative[]>();
  const HOOKS = isApparel ? ["UGC unboxing", "Before after", "Founder story", "Street style", "Detail close-up", "Try-on haul"] : ["Room makeover", "UGC review", "Before after", "Designer tip", "Detail close-up", "Cozy evening"];
  const ANGLES = ["Price", "Quality", "Novelty", "Social proof", "Comfort", "Limited stock"];
  let creativeSeq = 0;
  for (const c of camps) {
    const n = c.platform === "meta" ? rng.int(3, 6) : 2;
    const list: Creative[] = [];
    for (let k = 0; k < n; k++) {
      const format = c.platform === "meta" ? rng.weighted([["video", 40], ["image", 35], ["carousel", 25]] as const) : "text";
      const hook = rng.pick(HOOKS);
      const angle = rng.pick(ANGLES);
      const cr: Creative = { id: rng.uuid(), externalId: `${c.platform === "meta" ? "2385" : "6912"}${String(100000 + creativeSeq++)}`, campaignId: c.id, format, weight: 0.5 + rng.next(), ctrFactor: 0.7 + rng.next() * 0.7, fatigues: c.platform === "meta" && k === 0 };
      list.push(cr);
      ds.adCreatives.push(t({ id: cr.id, campaignId: c.id, platform: c.platform, externalId: cr.externalId, adsetExternalId: `${c.externalId}-as${1 + (k % 2)}`, adsetName: k % 2 ? (isApparel ? "Retargeting 30g" : "Retargeting 30d") : (isApparel ? "Prospecting broad" : "Prospecting broad"), name: c.platform === "meta" ? `${format.toUpperCase()} | ${hook} | ${angle}` : `${c.name} – RSA ${k + 1}`, format, hook: c.platform === "meta" ? hook.toLowerCase() : null, angle: c.platform === "meta" ? angle.toLowerCase() : null, headline: c.platform === "meta" ? `${hook} — ${angle}` : c.name, body: null, thumbnailUrl: null, status: c.status === "active" ? (rng.chance(0.85) ? "active" : "paused") : c.status, tags: [], syncedAt: now }));
    }
    creativesByCampaign.set(c.id, list);
  }
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
      const purchaseValueMinor = Math.round(purchases * (isApparel ? 7600 : 11200) * (0.8 + rng.next() * 0.4));
      ds.adMetricsDaily.push(t({ campaignId: c.id, date: iso(d), spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.55), purchases, purchaseValueMinor }));
      // split the day across the campaign's creatives; the "fatiguing" one loses CTR as it ages
      const crs = creativesByCampaign.get(c.id) ?? [];
      if (crs.length) {
        const ageDays = (d.getTime() - c.startedAt.getTime()) / 864e5;
        const weights = crs.map((cr) => cr.weight);
        const wsum = weights.reduce((a, b) => a + b, 0);
        // exact split: the ads of a campaign add up to its daily spend (reconciliation, issue #40)
        const spendShares = splitExact(spend, weights);
        crs.forEach((cr, k) => {
          const share = weights[k]! / wsum;
          const imp = Math.round(impressions * share);
          const ctrFactor = cr.fatigues ? Math.max(0.35, 1 - Math.max(0, ageDays - 10) * 0.012) : cr.ctrFactor;
          const clk = Math.round(imp * (c.platform === "meta" ? 0.012 : 0.03) * ctrFactor * (0.8 + rng.next() * 0.4));
          const pur = Math.round(clk * 0.025 * c.efficiency * (0.6 + rng.next() * 0.8));
          const reach = Math.max(1, Math.round(imp / (1.2 + (cr.fatigues ? Math.min(3, ageDays * 0.03) : 0.4))));
          ds.adCreativeMetricsDaily.push(t({ creativeId: cr.id, date: iso(d), spendMinor: spendShares[k]!, impressions: imp, reach, clicks: clk, purchases: pur, purchaseValueMinor: Math.round(pur * (isApparel ? 7600 : 11200) * (0.8 + rng.next() * 0.4)), videoViews3s: cr.format === "video" ? Math.round(imp * 0.28) : 0 }));
        });
      }
    }
  }

  /* ---------- discounts ---------- */
  const discountRows = DISCOUNT_CODES.map((d, i) => ({ ...d, id: rng.uuid(), startsAt: addDays(now, -rng.int(30, 400)), endsAt: i % 4 === 0 ? addDays(now, rng.int(-10, 60)) : null, used: 0 }));
  const poolId = rng.uuid();
  const poolCodes: { id: string; code: string; used: boolean; orderId?: string; at?: Date }[] = [];
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
  const buyerSequence = lifecycleCustomerSequence(cfg.seed + 7, customers.length, cfg.orderCount);

  for (let i = 0; i < cfg.orderCount; i++) {
    const placedAt = placedAts[i]!;
    const ageDays = (now.getTime() - placedAt.getTime()) / DAY;
    // customer: from the lifecycle simulation; occasionally a deliberate duplicate
    let customer: C;
    let dupOf: typeof lastDuplicateSource = null;
    if (lastDuplicateSource && placedAt.getTime() - lastDuplicateSource.placedAt.getTime() < 2 * DAY && rng.chance(0.5)) {
      customer = lastDuplicateSource.customer;
      dupOf = lastDuplicateSource;
      lastDuplicateSource = null;
    } else {
      customer = customers[buyerSequence[i]!]!;
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
    let orderCreativeId: string | null = null;
    let campaign: Camp | null = null;
    let channel = "direct";
    let utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null } = { source: null, medium: null, campaign: null, content: null };
    const clickIds: Record<string, string> = {};
    if (attributed && camps.length) {
      campaign = rng.weighted(campaignWeights);
      if (campaign.platform === "meta") {
        const crs = creativesByCampaign.get(campaign.id) ?? [];
        const cr = crs.length ? rng.weighted(crs.map((x) => [x, x.weight * x.ctrFactor] as const)) : null;
        orderCreativeId = cr?.id ?? null;
        utm = { source: rng.pick(["facebook", "instagram", "fb"]), medium: "paid", campaign: campaign.externalId, content: cr?.externalId ?? `ad_${rng.int(100, 999)}` };
        clickIds.fbclid = `IwAR${rng.int(1e9, 9e9).toString(36)}`;
        channel = "paid_social";
      } else {
        utm = { source: "google", medium: "cpc", campaign: campaign.externalId, content: null };
        clickIds.gclid = `Cj0K${rng.int(1e9, 9e9).toString(36)}`;
        channel = "paid_search";
      }
    } else {
      const c = rng.weighted([["direct", 40], ["organic_search", 22], ["email", 15], ["social", 10], ["referral", 8], ["unknown", 5]] as const);
      channel = c;
      if (c === "email") utm = { source: "newsletter", medium: "email", campaign: `weekly-${rng.int(1, 40)}`, content: null };
      if (c === "organic_search") utm = { source: "google", medium: "organic", campaign: null, content: null };
      if (c === "social") utm = { source: "instagram", medium: "social", campaign: null, content: null };
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
      landingSite, referringSite: channel === "referral" ? "https://blog.example/best-picks" : channel === "organic_search" ? "https://www.google.com/" : null, sourceChannel: rng.chance(0.03) ? "pos" : rng.chance(0.03) ? "draft" : "web", isTest: false,
      placedAt, cancelledAt, cancelReason: cancelled ? rng.pick(["customer", "inventory", "fraud", "other"]) : null, closedAt: deliveredAt, assignedTo, holdReason, platformUpdatedAt: deliveredAt ?? fulfilledAt ?? cancelledAt ?? placedAt, syncedAt: now,
    });
    for (const l of lines) ds.orderLines.push({ id: l.id, tenantId, orderId, externalId: l.externalId, productId: l.v.productId, variantId: l.v.id, sku: l.v.sku, title: l.v.productTitle, variantTitle: l.v.title, quantity: l.quantity, currentQuantity: cancelled ? 0 : l.quantity, unitPriceMinor: l.unitPriceMinor, discountMinor: Math.round((discountMinor * l.totalMinor) / Math.max(subtotal, 1)), totalMinor: l.totalMinor, unitCostMinor: l.v.costMinor, isAncillary: false });
    if (discountCode) {
      ds.orderDiscounts.push(t({ orderId, code: discountCode.code, type: discountCode.type, amountMinor: discountMinor }));
      // a pool code is redeemed by the order that used it
      if (discountCode.poolCodeIdx !== undefined) Object.assign(poolCodes[discountCode.poolCodeIdx]!, { orderId, at: placedAt });
    }
    ds.orderAttribution.push(t({ orderId, utmSource: utm.source, utmMedium: utm.medium, utmCampaign: utm.campaign, utmContent: utm.content, utmTerm: null, clickIds, campaignId: campaign?.id ?? null, channel, source: "seed", capturedAt: placedAt }));
    // touchpoints: the order's own landing visit plus 0–3 earlier visits in the 21 days before (multi-touch journeys)
    const paidChannel = channel === "paid_social" || channel === "paid_search";
    ds.touchpoints.push(t({ orderId, customerId: customer.id, anonymousId: null, sessionId: null, occurredAt: placedAt, channel, source: utm.source, medium: utm.medium, utmCampaign: utm.campaign, utmContent: utm.content, campaignId: campaign?.id ?? null, creativeId: orderCreativeId, clickId: clickIds.fbclid ?? clickIds.gclid ?? null, paid: paidChannel, landingUrl: null, origin: "order_landing" }));
    const earlier = rng.weighted([[0, 40], [1, 30], [2, 20], [3, 10]] as const);
    for (let k = 0; k < earlier; k++) {
      const when = new Date(placedAt.getTime() - rng.int(1, 21 * 24) * 3600e3);
      const paidTouch = camps.length > 0 && rng.chance(0.55);
      const pc = paidTouch ? rng.weighted(campaignWeights) : null;
      const pcr = pc ? rng.pick(creativesByCampaign.get(pc.id) ?? [null]) : null;
      const ch = pc ? (pc.platform === "meta" ? "paid_social" : "paid_search") : rng.weighted([["organic_search", 35], ["email", 30], ["social", 20], ["referral", 15]] as const);
      ds.touchpoints.push(t({ orderId, customerId: customer.id, anonymousId: null, sessionId: null, occurredAt: when, channel: ch, source: pc ? (pc.platform === "meta" ? "facebook" : "google") : null, medium: pc ? (pc.platform === "meta" ? "paid" : "cpc") : null, utmCampaign: pc?.externalId ?? null, utmContent: pcr?.externalId ?? null, campaignId: pc?.id ?? null, creativeId: pcr?.id ?? null, clickId: null, paid: Boolean(pc), landingUrl: null, origin: "seed" }));
    }
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
    if (!cancelled && !fulfilledAt && !partialFulfilment && ["new", "pending_review", "confirmed"].includes(status)) for (const l of lines) if (l.v.isLow && l.v.stockTotal < l.quantity + 2) openOrdersForBackorder.push({ orderId, lineId: l.id, variant: l.v, qty: l.quantity });
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
  for (const c of poolCodes) ds.discounts.push({ id: c.id, tenantId, externalId: null, poolId, code: c.code, title: null, type: "percentage", value: 1500, minimumAmountMinor: null, usageLimit: 1, usedCount: c.used ? 1 : 0, startsAt: addDays(now, -40), endsAt: addDays(now, 50), isActive: !c.used, source: "hullwise", syncedAt: null, redeemedOrderId: c.orderId ?? null, redeemedAt: c.at ?? null });
  // a later top-up of the pool (issue #35): codes handed to campaigns and customers, the rest ready. Own RNG, so the rest of the demo data does not move.
  {
    const prng = createRng(cfg.seed + 35);
    const taken = new Set(poolCodes.map((c) => c.code));
    const topUp = isApparel ? 140 : 100;
    const campaignIds = ds.campaigns.map((c) => c.id as string);
    for (let i = 0; i < topUp; i++) {
      const code = `${cfg.orderNumberPrefix}W${prng.int(0, 0xffffff).toString(36).toUpperCase().padStart(5, "X")}${i.toString(36).toUpperCase()}`;
      if (taken.has(code)) continue;
      taken.add(code);
      const toCampaign = i < 24 && campaignIds.length > 0;
      const toCustomer = !toCampaign && i < 40 && customers.length > 0;
      ds.discounts.push({ id: prng.uuid(), tenantId, externalId: null, poolId, code, title: null, type: "percentage", value: 1500, minimumAmountMinor: null, usageLimit: 1, usedCount: 0, startsAt: addDays(now, -40), endsAt: addDays(now, 50), isActive: true, source: "hullwise", syncedAt: null, assignedCampaignId: toCampaign ? campaignIds[i % Math.min(4, campaignIds.length)]! : null, assignedCustomerId: toCustomer ? customers[(i * 37) % customers.length]!.id : null, assignedAt: toCampaign || toCustomer ? addDays(now, -prng.int(1, 20)) : null });
    }
    const pool = ds.discountPools.find((p) => p.id === poolId)!;
    pool.targetSize = topUp - 40;
  }

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
  // backorders (issue #26): open orders on low-stock variants wait for stock. The variant is out of stock
  // (those orders took what was left), the order is held by the state engine (on_hold, awaiting stock)
  // and the backorder waits for the in-transit PO line of the variant when there is one.
  const chosen = openOrdersForBackorder.slice(0, 40).filter((b, i, all) => all.findIndex((x) => x.lineId === b.lineId) === i);
  // demo guarantee: at least one waiting order shows a PO and an ETA (append a line to an incoming PO if needed)
  const incomingPo = ds.purchaseOrders.find((po) => po.status === "in_transit") ?? ds.purchaseOrders.find((po) => po.status === "confirmed");
  if (chosen.length && incomingPo && !chosen.some((b) => inTransitLines.some((l) => l.variant.id === b.variant.id))) {
    const b = chosen[0]!;
    const lineId = rng.uuid();
    const unitCost = b.variant.costMinor;
    ds.purchaseOrderLines.push({ id: lineId, tenantId, purchaseOrderId: incomingPo.id, variantId: b.variant.id, description: null, quantity: 24, receivedQuantity: 0, unitCostMinor: unitCost });
    incomingPo.totalMinor = (incomingPo.totalMinor as number) + 24 * unitCost;
    inTransitLines.push({ lineId, variant: b.variant });
  }
  const outOfStock = new Set(chosen.map((b) => b.variant.id));
  for (const lvl of ds.inventoryLevels) if (outOfStock.has(lvl.variantId as string)) Object.assign(lvl, { available: 0, onHand: lvl.committed });
  for (const v of variants) if (outOfStock.has(v.id)) v.stockTotal = 0;
  const heldOrders = new Map<string, { quantity: number; sku: string; title: string; poNumber: string | null; expectedAt: string | null }[]>();
  for (const b of chosen) {
    const cover = inTransitLines.find((l) => l.variant.id === b.variant.id);
    const po = cover ? ds.purchaseOrders.find((x) => ds.purchaseOrderLines.some((l) => l.id === cover.lineId && l.purchaseOrderId === x.id)) : undefined;
    ds.backorders.push(t({ orderLineId: b.lineId, orderId: b.orderId, variantId: b.variant.id, quantity: b.qty, purchaseOrderLineId: cover?.lineId ?? null, status: cover ? "covered" : "pending", resolvedAt: null }));
    heldOrders.set(b.orderId, [...(heldOrders.get(b.orderId) ?? []), { quantity: b.qty, sku: b.variant.sku, title: `${b.variant.productTitle} ${b.variant.title}`, poNumber: (po?.number as string | undefined) ?? null, expectedAt: po?.expectedAt ? (po.expectedAt as Date).toISOString().slice(0, 10) : null }]);
  }
  for (const [orderId, described] of heldOrders) {
    const o = ds.orders.find((x) => x.id === orderId)!;
    const at = addHours(o.placedAt as Date, 0.05);
    const previous = o.status;
    Object.assign(o, { status: "on_hold", statusSource: "rules", statusReason: AWAITING_STOCK_REASON, manualStatus: null, holdReason: null, statusChangedAt: at });
    sysEvent(orderId, "backorder_created", at, { diff: { awaitingUnits: { from: 0, to: described.reduce((s, d) => s + d.quantity, 0) } }, metadata: { lines: described, source: "sync" } });
    sysEvent(orderId, "status_changed", at, { diff: { status: { from: previous, to: "on_hold" } }, metadata: { reason: AWAITING_STOCK_REASON } });
  }
  if (ds.backorders.length === 0) {
    // isolation suite: every tenant has a row; a closed wait changes nothing on the order
    const anyLine = ds.orderLines[0]!;
    ds.backorders.push(t({ orderLineId: anyLine.id, orderId: anyLine.orderId, variantId: anyLine.variantId, quantity: 1, purchaseOrderLineId: null, status: "cancelled", resolvedAt: now }));
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
    { name: isApparel ? "Clienti ricorrenti" : "Repeat customers", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] }, holdout: cfg.addons.includes("addon.customer_campaigns") ? 20 : 0, test: (c: C) => c.ordersCount >= 2 },
    { name: isApparel ? "Alto valore, inattivi 90gg" : "High value, inactive 90d", rules: { match: "all", conditions: [{ field: "total_spent", op: "gte", value: isApparel ? 25000 : 40000 }, { field: "days_since_last_order", op: "gte", value: 90 }] }, holdout: cfg.addons.includes("addon.customer_campaigns") ? 20 : 0, test: (c: C) => c.totalSpent >= (isApparel ? 25000 : 40000) && !!c.lastOrderAt && (now.getTime() - c.lastOrderAt.getTime()) / DAY >= 90 },
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
    ds.integrations.push(t({ provider, status: "connected", mode: "mock", externalAccountId: accId, externalAccountName: accName, credentialsEncrypted: null, config: provider === "shopify" ? { webhooksRegistered: true, apiVersion: "2025-07" } : provider === "google" && cfg.key === "northwind" ? { writeAccess: true } : {}, lastSyncAt: addHours(now, -1), lastSuccessAt: addHours(now, -1), lastError: null }));
    ds.integrationHealth.push(t({ source: provider, status: "ok", lastSuccessAt: addHours(now, -1), lastAttemptAt: addHours(now, -1), lastMetricDate: iso(addDays(now, -1)), consecutiveFailures: 0, rowsWrittenLast: provider === "shopify" ? 42 : 310, freshnessMinutes: provider === "shopify" ? 30 : provider === "meta" ? 60 : 720, lastError: null, meta: {} }));
    ds.syncRuns.push(t({ provider, objectType: provider === "shopify" ? "orders" : "metrics", kind: "delta", status: "success", cursor: {}, rowsWritten: 42, rowsScanned: provider === "shopify" ? 57 : 310, conflicts: 0, errorCount: 0, durationMs: provider === "shopify" ? 4200 : 9800, error: null, startedAt: addHours(now, -1), finishedAt: addHours(now, -0.98) }));
  }
  // the AI assistant runs on the store's own Anthropic key; in the demo the key is a mock connection
  ds.integrations.push(t({ provider: "anthropic", status: "connected", mode: "mock", externalAccountId: "claude-opus-5-5", externalAccountName: "Claude (mock)", credentialsEncrypted: null, config: {}, lastSyncAt: null, lastSuccessAt: addHours(now, -2), lastError: null }));
  // address validation (issue #7): the simulated provider, connected; a live Google key replaces it per store
  ds.integrations.push(t({ provider: "address", status: "connected", mode: "mock", externalAccountId: "address-mock", externalAccountName: "Simulated address provider", credentialsEncrypted: null, config: {}, lastSyncAt: null, lastSuccessAt: addHours(now, -2), lastError: null }));
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

  applyCatalogQualityGaps(ds, now);

  /* ---------- platform writes (outbox), nightly reconcile runs, stock drift ---------- */
  // Last in the generator so the rows above keep their deterministic ids.
  const nightly = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0) - (now.getUTCHours() < 3 ? DAY : 0));
  const catalogScanned = ds.productVariants.length * locations.length + ds.products.length;
  ds.syncRuns.push(t({ provider: "shopify", objectType: "orders", kind: "reconcile", status: "success", cursor: {}, rowsWritten: isApparel ? 37 : 14, rowsScanned: isApparel ? 1460 : 590, conflicts: 1, errorCount: 0, durationMs: isApparel ? 48_300 : 21_700, summary: {}, error: null, startedAt: nightly, finishedAt: new Date(nightly.getTime() + (isApparel ? 48_300 : 21_700)) }));
  ds.syncRuns.push(t({ provider: "shopify", objectType: "catalog", kind: "reconcile", status: "success", cursor: { phase: "finalize" }, rowsWritten: isApparel ? 212 : 96, rowsScanned: catalogScanned, conflicts: 3, errorCount: 0, durationMs: isApparel ? 31_900 : 12_400, summary: { products: ds.products.length, inventory: isApparel ? 180 : 80, discounts: 4, zeroed: 1, drift: 2, clamped: 1 }, error: null, startedAt: new Date(nightly.getTime() + 60_000), finishedAt: new Date(nightly.getTime() + 60_000 + (isApparel ? 31_900 : 12_400)) }));
  const pv = ds.productVariants.filter((v) => v.externalId && v.inventoryItemExternalId);
  const [v1, v2, v3, v4] = [3, 11, 19, 27].map((i) => pv[i % pv.length]!) as [Row, Row, Row, Row];
  const productOf = (v: Row) => ds.products.find((p) => p.id === v.productId)!;
  const [loc0, loc1] = [locations[0]!, locations[1] ?? locations[0]!];
  const levelOf = (v: Row, locId: string) => (ds.inventoryLevels.find((l) => l.variantId === v.id && l.locationId === locId)?.available as number | undefined) ?? 0;
  const metaCampaign = ds.campaigns.find((c) => c.platform === "meta" && c.status === "paused") ?? ds.campaigns.find((c) => c.platform === "meta")!;
  const w = (row: Row) => t({ mode: "async", attempts: 1, maxAttempts: 6, lastError: null, lastErrorCode: null, result: null, actorType: "user", actorUserId: userIds[0] ?? null, ...row, payloadHash: `seed-${String(row.kind)}-${String(row.targetKey)}`, idempotencyKey: `seed:${String(row.kind)}:${String(row.targetKey)}` });
  ds.platformWrites.push(w({ provider: "shopify", kind: "variant.update", entityType: "variant", entityId: v1.id, targetKey: `variant:${v1.externalId}:price`, payload: { variantExternalId: v1.externalId, priceMinor: v1.priceMinor }, status: "succeeded", nextAttemptAt: addHours(now, -3), startedAt: addHours(now, -3), completedAt: addHours(now, -3), createdAt: addHours(now, -3) }));
  ds.platformWrites.push(w({ provider: "meta", kind: "campaign.status", entityType: "campaign", entityId: metaCampaign.id, targetKey: `campaign:meta:${metaCampaign.externalId}:status`, payload: { provider: "meta", campaignExternalId: metaCampaign.externalId, status: metaCampaign.status === "paused" ? "paused" : "active" }, status: "succeeded", attempts: 2, nextAttemptAt: addHours(now, -26), startedAt: addHours(now, -26), completedAt: addHours(now, -26), createdAt: addHours(now, -26) }));
  const p2 = productOf(v2);
  ds.platformWrites.push(w({ provider: "shopify", kind: "product.status", entityType: "product", entityId: p2.id, targetKey: `product:${p2.externalId}:status`, payload: { productExternalId: p2.externalId, status: p2.status }, status: "failed", nextAttemptAt: addHours(now, -5), lastError: "[permission] Missing scope write_products: reinstall the app with product write access", lastErrorCode: "permission", startedAt: addHours(now, -5), completedAt: addHours(now, -5), createdAt: addHours(now, -5) }));
  ds.platformWrites.push(w({ provider: "shopify", kind: "inventory.set", entityType: "variant", entityId: v3.id, targetKey: `inventory:${v3.inventoryItemExternalId}@${loc1.externalId}`, payload: { inventoryItemExternalId: v3.inventoryItemExternalId, locationExternalId: loc1.externalId, available: levelOf(v3, loc1.id as string) }, status: "pending", nextAttemptAt: addHours(now, 0.25), lastError: "[rate_limited] Throttled: retry after 15 minutes", lastErrorCode: "rate_limited", startedAt: addHours(now, -0.1), completedAt: null, createdAt: addHours(now, -0.1) }));
  const drift = (row: Row) => t({ source: "reconcile", runId: null, detail: {}, occurrences: 1, detectedAt: addHours(nightly, 0.02), lastSeenAt: addHours(nightly, 0.02), ...row, delta: (row.observed as number) - (row.expected as number) });
  const l2 = levelOf(v2, loc0.id as string);
  ds.inventoryDrift.push(drift({ variantId: v2.id, locationId: loc0.id, kind: "unexplained", localBefore: l2 + 4, expected: l2 + 3, observed: l2, applied: l2, detail: { explained: -1, locations: [{ locationId: loc0.id, local: l2 + 4, observed: l2 }] }, dedupeKey: `seed:unexplained:${v2.id}` }));
  ds.inventoryDrift.push(drift({ variantId: v4.id, locationId: loc0.id, kind: "negative", localBefore: 1, expected: 0, observed: -2, applied: 0, dedupeKey: `seed:negative:${v4.id}`, occurrences: 2 }));
  ds.inventoryDrift.push(drift({ variantId: v1.id, locationId: loc1.id, kind: "not_reported", localBefore: 6, expected: 6, observed: 0, applied: 0, dedupeKey: `seed:not_reported:${v1.id}` }));

  return ds;
}

/**
 * Where each cost came from, and a few gaps for the catalog data-quality page and the P/L cost
 * warning. No rng draws, so the rest of the dataset is unchanged: a product never bought on a
 * purchase order (but sold) has no cost, nor do the lines it sold on; a few variants have no
 * barcode. Images come with the gallery (`ensureDemoProductCatalog`). The duplicate SKU is written after the planning extras
 * (`seedCatalogDuplicate`), which order variants by SKU.
 */
function applyCatalogQualityGaps(ds: TenantDataset, now: Date): void {
  const receivedAt = new Map<string, Date>();
  const poReceived = new Map(ds.purchaseOrders.map((p) => [p.id as string, (p.receivedAt as Date | null) ?? now]));
  const onPo = new Set<string>();
  for (const l of ds.purchaseOrderLines) {
    onPo.add(l.variantId as string);
    if ((l.receivedQuantity as number) <= 0) continue;
    const at = poReceived.get(l.purchaseOrderId as string) ?? now;
    const prev = receivedAt.get(l.variantId as string);
    if (!prev || prev < at) receivedAt.set(l.variantId as string, at);
  }
  const sold = new Set(ds.orderLines.map((l) => l.variantId as string));
  const variantsOf = new Map<string, Row[]>();
  for (const v of ds.productVariants) variantsOf.set(v.productId as string, [...(variantsOf.get(v.productId as string) ?? []), v]);
  const products = ds.products;
  const half = Math.floor(products.length / 2);
  const uncosted = [...products.slice(half), ...products.slice(0, half)].find((p) => {
    const vs = variantsOf.get(p.id as string) ?? [];
    return vs.length > 0 && vs.every((v) => !onPo.has(v.id as string)) && vs.some((v) => sold.has(v.id as string));
  });
  const noCost = new Set((uncosted ? variantsOf.get(uncosted.id as string) ?? [] : []).map((v) => v.id as string));
  products.forEach((p, i) => {
    if (i % 29 === 7) {
      const last = (variantsOf.get(p.id as string) ?? []).at(-1);
      if (last) last.barcode = null;
    }
  });
  for (const v of ds.productVariants) {
    const id = v.id as string;
    if (noCost.has(id)) Object.assign(v, { costMinor: null, averageCostMinor: null, costSource: null, costUpdatedAt: null });
    else if (receivedAt.has(id)) Object.assign(v, { costSource: "po_receipt", costUpdatedAt: receivedAt.get(id) });
    else Object.assign(v, { costSource: "platform", costUpdatedAt: v.syncedAt ?? now });
  }
  for (const l of ds.orderLines) if (noCost.has(l.variantId as string)) l.unitCostMinor = null;
}
