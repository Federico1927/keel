import { createRng } from "../rng";
import type { NormalizedCustomer, NormalizedLocation } from "../types";
import type { MockCatalogVariant, MockCommerceOptions } from "./commerce";

const PRODUCTS = [
  { title: "Everyday Tote", type: "Bags", price: 4900, options: { Color: ["Sand", "Black"] } },
  { title: "Linen Shirt", type: "Tops", price: 5900, options: { Size: ["S", "M", "L"] } },
  { title: "Merino Beanie", type: "Accessories", price: 2900, options: { Color: ["Grey", "Navy"] } },
  { title: "Canvas Sneakers", type: "Shoes", price: 8900, options: { Size: ["38", "40", "42"] } },
  { title: "Ceramic Mug", type: "Home", price: 1800, options: { Color: ["White", "Clay"] } },
  { title: "Rain Jacket", type: "Outerwear", price: 12900, options: { Size: ["S", "M", "L"] } },
  { title: "Wool Scarf", type: "Accessories", price: 3900, options: { Color: ["Camel", "Grey"] } },
  { title: "Cotton Hoodie", type: "Tops", price: 6900, options: { Size: ["S", "M", "L"] } },
] as const;
const FIRST = ["Alex", "Sam", "Jordan", "Maria", "Luca", "Emma", "Noah", "Sofia", "Leo", "Mia", "Ines", "Tom"];
const LAST = ["Rossi", "Smith", "Garcia", "Müller", "Bianchi", "Martin", "Lopez", "Brown", "Ricci", "Dubois"];

/**
 * A small simulated store for a tenant that connects Shopify in mock mode with no data of its own
 * (issue #87): 8 products with variants, two locations, 150 customers and `orders` orders spread over the
 * last `months` months, all derived from `key` so the same tenant always sees the same store.
 */
export function mockDemoStore(opts: { key: string; currency: string; country: string; orderNumberPrefix: string; months: number; orders: number; now?: Date }): Omit<MockCommerceOptions, "webhookSecret" | "paymentOrders"> {
  let seed = 0;
  for (const ch of opts.key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = createRng(seed || 7);
  const base = 7_700_000_000 + (seed % 1_000_000) * 1000;
  const variants: MockCatalogVariant[] = [];
  PRODUCTS.forEach((p, i) => {
    const [optName, values] = Object.entries(p.options)[0] as [string, readonly string[]];
    values.forEach((v, j) => {
      const id = base + i * 10 + j;
      variants.push({ externalId: String(id), productExternalId: String(base + 500 + i), inventoryItemExternalId: String(id + 100_000), sku: `${p.title.split(" ").map((w) => w.slice(0, 3).toUpperCase()).join("-")}-${v.toUpperCase()}`, title: v, productTitle: p.title, optionValues: { [optName]: v }, priceMinor: p.price, unitCostMinor: Math.round(p.price * 0.38) });
    });
  });
  const locations: NormalizedLocation[] = [{ externalId: String(base + 900), name: "Main warehouse", country: opts.country, isDefault: true, isActive: true }, { externalId: String(base + 901), name: "Shop floor", country: opts.country, isDefault: false, isActive: true }];
  const customers: NormalizedCustomer[] = Array.from({ length: 150 }, (_, i) => {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    return { externalId: String(base + 10_000 + i), email: `${first}.${last}.${i}@example.com`.toLowerCase().replace(/ü/g, "u"), phone: null, firstName: first, lastName: last, country: opts.country, city: null, zip: null, acceptsMarketing: rng.chance(0.4), tags: [], platformCreatedAt: null };
  });
  return { seed: seed || 7, currency: opts.currency, country: opts.country, orderNumberPrefix: opts.orderNumberPrefix, startOrderNumber: 1001, variants, locations, customers, history: { orders: opts.orders, months: opts.months, now: opts.now } };
}
