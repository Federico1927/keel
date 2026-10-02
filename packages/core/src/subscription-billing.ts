import { BILLING_PRODUCT_NAMES, MODULES, PLANS, PLAN_KEYS, PRODUCT_NAME, isAddonModule, type PlanKey } from "@keel/config";

/**
 * Stripe billing (#53), pure part: the catalog Keel pushes to Stripe (one product and one price
 * per plan, setup fee and add-on, matched by lookup key), the changes a sync needs, how a Stripe
 * subscription status maps onto the tenant lifecycle, subscription item changes for plan and
 * add-on edits, MRR from mirrored subscriptions, the key mode and the VAT treatment.
 */

export type CatalogKind = "plan" | "setup" | "addon";

export interface CatalogItem {
  /** Stable Stripe lookup key: moves to the new price when an amount changes. */
  lookupKey: string;
  /** Deterministic Stripe product id (Stripe accepts a custom id on create). */
  productId: string;
  kind: CatalogKind;
  /** Plan key or add-on module key. */
  key: string;
  name: string;
  amountMinor: number;
  currency: string;
  /** Recurring interval; null for the one-off setup fee. */
  interval: "month" | null;
}

const slug = (key: string) => key.replace(/^addon\./, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();

export function lookupKeyFor(kind: CatalogKind, key: string): string {
  return kind === "setup" ? `keel_setup_${slug(key)}` : `keel_${kind}_${slug(key)}_monthly`;
}

export function productIdFor(kind: CatalogKind, key: string): string {
  return `keel_${kind}_${slug(key)}`;
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Everything sellable, from @keel/config: plans (monthly), their setup fees (one-off), priced and implemented add-ons (monthly). */
export function billingCatalog(): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const key of PLAN_KEYS) {
    const p = PLANS[key];
    out.push({ lookupKey: lookupKeyFor("plan", key), productId: productIdFor("plan", key), kind: "plan", key, name: `${PRODUCT_NAME} ${title(key)}`, amountMinor: p.monthlyPriceMinor, currency: p.currency, interval: "month" });
    out.push({ lookupKey: lookupKeyFor("setup", key), productId: productIdFor("setup", key), kind: "setup", key, name: `${PRODUCT_NAME} ${title(key)} setup fee`, amountMinor: p.setupFeeMinor, currency: p.currency, interval: null });
  }
  const currency = PLANS[PLAN_KEYS[0]].currency;
  for (const def of Object.values(MODULES)) {
    if (!isAddonModule(def.key) || def.availability !== "implemented" || !def.monthlyPriceMinor) continue;
    out.push({ lookupKey: lookupKeyFor("addon", def.key), productId: productIdFor("addon", def.key), kind: "addon", key: def.key, name: `${PRODUCT_NAME} add-on: ${BILLING_PRODUCT_NAMES[def.key] ?? title(slug(def.key).replace(/_/g, " "))}`, amountMinor: def.monthlyPriceMinor, currency, interval: "month" });
  }
  return out;
}

/** The catalog entry behind a lookup key (Stripe line items, subscription items). */
export function catalogItemFor(lookupKey: string | null | undefined, catalog: readonly CatalogItem[] = billingCatalog()): CatalogItem | null {
  return lookupKey ? (catalog.find((c) => c.lookupKey === lookupKey) ?? null) : null;
}

export interface CatalogCurrent {
  product: { name: string; active: boolean } | null;
  price: { id: string; productId: string; amountMinor: number; currency: string; interval: "month" | null } | null;
}

export interface CatalogChange {
  createProduct: boolean;
  /** Name changed or the product was archived. */
  updateProduct: boolean;
  /** Prices are immutable: a different amount, currency or interval means a new price. */
  createPrice: boolean;
  /** The price the lookup key leaves, archived after the new one takes the key. */
  archivePriceId: string | null;
}

export function catalogChange(desired: CatalogItem, current: CatalogCurrent): CatalogChange {
  const p = current.price;
  const samePrice = Boolean(p && p.productId === desired.productId && p.amountMinor === desired.amountMinor && p.currency.toLowerCase() === desired.currency.toLowerCase() && p.interval === desired.interval);
  return {
    createProduct: !current.product,
    updateProduct: Boolean(current.product && (current.product.name !== desired.name || !current.product.active)),
    createPrice: !samePrice,
    archivePriceId: p && !samePrice ? p.id : null,
  };
}

export function isCatalogUnchanged(c: CatalogChange): boolean {
  return !c.createProduct && !c.updateProduct && !c.createPrice;
}

/** Restricted (`rk_`) or secret (`sk_`) key: test or live from the prefix; null without a usable key. */
export function stripeKeyMode(key: string | null | undefined): "test" | "live" | null {
  const m = /^(?:sk|rk)_(test|live)_/.exec((key ?? "").trim());
  return m ? (m[1] as "test" | "live") : null;
}

/** What a Stripe subscription status means for Keel. `pending` = checkout not finished yet; `inactive` = paused. */
export type SubscriptionSignal = "trial" | "active" | "past_due" | "cancelled" | "pending" | "inactive";

export function subscriptionSignal(externalStatus: string | null | undefined): SubscriptionSignal {
  switch (externalStatus) {
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    case "paused":
      return "inactive";
    default:
      return "pending";
  }
}

/** Lookup keys a subscription should carry: the plan and every priced, implemented add-on that is active. */
export function desiredSubscriptionKeys(planKey: PlanKey, addons: readonly string[]): string[] {
  const keys = [lookupKeyFor("plan", planKey)];
  for (const a of [...addons].sort()) {
    const def = MODULES[a as keyof typeof MODULES];
    if (def && isAddonModule(def.key) && def.availability === "implemented" && def.monthlyPriceMinor) keys.push(lookupKeyFor("addon", a));
  }
  return keys;
}

export interface SubscriptionItemRef {
  itemId: string;
  lookupKey: string | null;
}

export interface SubscriptionItemChanges {
  /** Lookup keys to add as new items. */
  add: string[];
  /** Items to delete. */
  remove: string[];
  /** Items kept whose price changes (a plan change keeps the item for a clean proration). */
  swap: { itemId: string; lookupKey: string }[];
}

export function subscriptionItemChanges(current: readonly SubscriptionItemRef[], desired: readonly string[]): SubscriptionItemChanges {
  const want = new Set(desired);
  const have = new Set(current.map((c) => c.lookupKey ?? ""));
  const isPlan = (k: string | null) => Boolean(k && k.startsWith("keel_plan_"));
  const desiredPlan = desired.find(isPlan) ?? null;
  const swap: SubscriptionItemChanges["swap"] = [];
  const remove: string[] = [];
  for (const item of current) {
    if (item.lookupKey && want.has(item.lookupKey)) continue;
    if (isPlan(item.lookupKey) && desiredPlan && !have.has(desiredPlan) && !swap.length) swap.push({ itemId: item.itemId, lookupKey: desiredPlan });
    else remove.push(item.itemId);
  }
  const swapped = new Set(swap.map((s) => s.lookupKey));
  const add = desired.filter((k) => !have.has(k) && !swapped.has(k));
  return { add, remove, swap };
}

export function hasItemChanges(c: SubscriptionItemChanges): boolean {
  return c.add.length + c.remove.length + c.swap.length > 0;
}

/** MRR from the subscriptions mirrored from Stripe: recurring items of active and past-due subscriptions. */
export function mirroredMrr(subs: readonly { externalStatus: string | null; items: readonly { unitAmountMinor: number; quantity: number; interval: string | null }[] }[]): number {
  return subs
    .filter((s) => s.externalStatus === "active" || s.externalStatus === "past_due")
    .reduce((sum, s) => sum + s.items.filter((i) => i.interval === "month").reduce((a, i) => a + i.unitAmountMinor * i.quantity, 0), 0);
}

export const EU_COUNTRIES = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"] as const;
const EU = new Set<string>(EU_COUNTRIES);
/** Stripe reports Greece's VAT ids as `eu_vat` with prefix EL; both mean Greece. */
const normCountry = (c: string | null | undefined) => (c ?? "").trim().toUpperCase().replace(/^EL$/, "GR") || null;

export type VatTreatment = "domestic" | "reverse_charge" | "eu_b2c" | "export" | "unknown";

/**
 * VAT on Keel's own invoices. Domestic customers pay the seller's VAT; EU business customers with
 * a verified VAT id in another member state are invoiced without VAT (reverse charge); EU consumers
 * pay VAT of their country; customers outside the EU are out of scope. Unknown without the seller's
 * country (no default: CLAUDE.md §12) or the customer's.
 */
export function vatTreatment(input: { sellerCountry: string | null | undefined; customerCountry: string | null | undefined; vatIdVerified: boolean }): VatTreatment {
  const seller = normCountry(input.sellerCountry);
  const customer = normCountry(input.customerCountry);
  if (!seller || !customer) return "unknown";
  if (seller === customer) return "domestic";
  if (!EU.has(seller)) return "unknown";
  if (!EU.has(customer)) return "export";
  return input.vatIdVerified ? "reverse_charge" : "eu_b2c";
}

const INVOICE_RANK: Record<string, number> = { draft: 0, open: 1, uncollectible: 2, paid: 3, void: 3 };

/** Stripe does not guarantee event order: an invoice never moves back (paid and void are final, open never undoes uncollectible). */
export function mergeInvoiceStatus(current: string | null, incoming: string): string {
  if (!current) return incoming;
  if (current === "paid" || current === "void") return current;
  return (INVOICE_RANK[incoming] ?? 0) >= (INVOICE_RANK[current] ?? 0) ? incoming : current;
}
