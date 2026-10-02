import type { AdsPlatform, CommercePlatform, CreateFulfillmentInput, CreateOrderInput, NormalizedFulfillment, NormalizedOrder, OrderDetailsPatch, OrderDiscountPatch, PlatformReturnLineInput, VariantPatch, FulfillmentHoldInput } from "@keel/integrations";
import type { schema } from "@keel/db";
import type { ServiceContext } from "../context";

export type WriteProvider = "shopify" | "meta" | "google";
export type PlatformWriteRow = typeof schema.platformWrites.$inferSelect;
export type PlatformWriteStatus = "pending" | "running" | "succeeded" | "failed" | "superseded";

/** Dates travel as ISO strings: the payload is stored as JSON and executed later. */
export interface DiscountCodePayload {
  code: string;
  title: string;
  type: "percentage" | "fixed_amount" | "free_shipping";
  value: number;
  startsAt?: string | null;
  endsAt?: string | null;
  usageLimit?: number | null;
  minimumAmountMinor?: number | null;
}

/**
 * Every write Keel makes to a platform, by kind: payload in, result out. Adding a write type is
 * one entry here plus one `defineCommerceWrite` / `defineAdsWrite` call in `kinds.ts` (an add-on
 * package can augment this interface through `declare module "@keel/services/writes/registry"`).
 */
export interface PlatformWriteKinds {
  "variant.update": { payload: { variantExternalId: string; priceMinor: number }; result: void };
  "variant.cost": { payload: { variantExternalId: string; inventoryItemExternalId: string | null; costMinor: number }; result: void };
  "variant.prices": { payload: { variantExternalId: string; patch: VariantPatch }; result: void };
  "product.status": { payload: { productExternalId: string; status: "active" | "draft" | "archived" }; result: void };
  "product.tags": { payload: { productExternalId: string; add: string[]; remove: string[] }; result: void };
  "inventory.set": { payload: { inventoryItemExternalId: string; locationExternalId: string; available: number }; result: void };
  "inventory.restock": { payload: { lines: { inventoryItemExternalId: string; locationExternalId: string; quantity: number }[] }; result: void };
  "order.cancel": { payload: { orderExternalId: string; reason?: string; restock: boolean; refund: boolean }; result: void };
  "order.update_details": { payload: { orderExternalId: string; patch: OrderDetailsPatch }; result: void };
  "order.discount": { payload: { orderExternalId: string; discount: OrderDiscountPatch }; result: void };
  "order.tags": { payload: { orderExternalId: string; add: string[]; remove: string[] }; result: void };
  "order.fulfillment_hold": { payload: { orderExternalId: string; hold: FulfillmentHoldInput }; result: void };
  "order.fulfillment_release": { payload: { orderExternalId: string }; result: void };
  "order.create": { payload: { input: CreateOrderInput }; result: NormalizedOrder };
  "order.create_invoice": { payload: { input: CreateOrderInput }; result: { draftExternalId: string; invoiceUrl: string | null } };
  "discount.create": { payload: DiscountCodePayload; result: { externalId: string } };
  "discount.pool": { payload: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: string | null; endsAt?: string | null }; result: { externalId: string; imported: string[]; failed: string[] } };
  "return.request": { payload: { orderExternalId: string; lines: PlatformReturnLineInput[]; note?: string | null }; result: { externalId: string; lines: { orderLineExternalId: string; externalId: string }[] } };
  "return.approve": { payload: { returnExternalId: string }; result: void };
  "return.decline": { payload: { returnExternalId: string; note: string | null }; result: void };
  "return.refund": { payload: { orderExternalId: string; lines: { orderLineExternalId: string; quantity: number }[]; amountMinor: number; currency: string; note?: string | null; notify: boolean }; result: { externalId: string; amountMinor: number } };
  "return.close": { payload: { returnExternalId: string }; result: void };
  "fulfillment.create": { payload: { input: CreateFulfillmentInput }; result: NormalizedFulfillment };
  "campaign.status": { payload: { provider: "meta" | "google"; campaignExternalId: string; status: "active" | "paused" }; result: void };
}
export type PlatformWriteKind = keyof PlatformWriteKinds;
export type WritePayload<K extends PlatformWriteKind> = PlatformWriteKinds[K]["payload"];
export type WriteResult<K extends PlatformWriteKind> = PlatformWriteKinds[K]["result"];

export interface WriteHandler<K extends PlatformWriteKind = PlatformWriteKind> {
  provider(payload: WritePayload<K>): WriteProvider;
  /** The platform object written: a newer write on the same target supersedes older pending ones when `supersedes` is set. */
  target(payload: WritePayload<K>): string;
  /** Absolute values (a price, a status, a stock level): only the last one matters. Partial patches and one-shot actions keep every write. */
  supersedes: boolean;
  execute(adapter: CommercePlatform | AdsPlatform, payload: WritePayload<K>): Promise<WriteResult<K>>;
  /** Local follow-up once the platform accepted the write (store the external id…), in the same transaction as the status. */
  onSuccess?(ctx: ServiceContext, write: PlatformWriteRow, result: WriteResult<K>): Promise<void>;
  /** Rebuilds a stored JSON result (dates) when a synchronous write is answered from the outbox. */
  revive?(result: unknown): WriteResult<K>;
}

const registry = new Map<string, WriteHandler>();

interface CommerceDef<K extends PlatformWriteKind> extends Omit<WriteHandler<K>, "provider" | "execute" | "supersedes"> {
  supersedes?: boolean;
  execute(platform: CommercePlatform, payload: WritePayload<K>): Promise<WriteResult<K>>;
}
interface AdsDef<K extends PlatformWriteKind> extends Omit<WriteHandler<K>, "execute" | "supersedes"> {
  supersedes?: boolean;
  execute(platform: AdsPlatform, payload: WritePayload<K>): Promise<WriteResult<K>>;
}

/** Registers a write executed through the tenant's `CommercePlatform` (Shopify or its mock). */
export function defineCommerceWrite<K extends PlatformWriteKind>(kind: K, def: CommerceDef<K>): void {
  registry.set(kind, { ...def, supersedes: def.supersedes ?? false, provider: () => "shopify", execute: (a: CommercePlatform | AdsPlatform, p: WritePayload<K>) => def.execute(a as CommercePlatform, p) } as unknown as WriteHandler);
}

/** Registers a write executed through an `AdsPlatform` (Meta or Google, chosen by the payload). */
export function defineAdsWrite<K extends PlatformWriteKind>(kind: K, def: AdsDef<K>): void {
  registry.set(kind, { ...def, supersedes: def.supersedes ?? false, execute: (a: CommercePlatform | AdsPlatform, p: WritePayload<K>) => def.execute(a as AdsPlatform, p) } as unknown as WriteHandler);
}

export function writeHandler<K extends PlatformWriteKind>(kind: K | string): WriteHandler<K> | undefined {
  return registry.get(kind) as WriteHandler<K> | undefined;
}

export function registeredWriteKinds(): string[] {
  return [...registry.keys()];
}
