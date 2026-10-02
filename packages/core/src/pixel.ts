import { z } from "zod";
import { deriveChannel, extractAttribution, type Attribution, type AttributionChannel } from "./attribution";

/**
 * First-party pixel: event shape accepted by the collect endpoint and the touchpoint a session
 * produces. The browser script (served by Hullwise or pasted as a Shopify custom pixel) generates a
 * long-lived anonymous id and a 30-minute session id on the store's own domain.
 */
export const PIXEL_EVENTS = ["page_view", "product_view", "add_to_cart", "checkout_started", "checkout_completed", "identify"] as const;
export type PixelEventName = (typeof PIXEL_EVENTS)[number];

const id = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9._-]+$/);
const shortText = z.string().max(2000).nullish();
export const pixelEventSchema = z.object({
  event: z.enum(PIXEL_EVENTS),
  anonymousId: id,
  sessionId: id,
  url: shortText,
  referrer: shortText,
  /** Client time; the server clamps it to a sane window. */
  ts: z.number().int().positive().optional(),
  props: z
    .object({
      orderId: z.string().max(64).nullish(),
      checkoutToken: z.string().max(128).nullish(),
      email: z.string().max(320).nullish(),
      productId: z.string().max(64).nullish(),
      value: z.number().nonnegative().nullish(),
      currency: z.string().max(3).nullish(),
      fbp: z.string().max(200).nullish(),
      fbc: z.string().max(400).nullish(),
    })
    .partial()
    .default({}),
});
export type PixelEvent = z.infer<typeof pixelEventSchema>;
export const pixelBatchSchema = z.object({ events: z.array(pixelEventSchema).min(1).max(25) });

/** Event time: the client clock when within 10 minutes of the server, the server clock otherwise. */
export function pixelEventTime(ts: number | undefined, receivedAt: Date): Date {
  if (!ts) return receivedAt;
  return Math.abs(ts - receivedAt.getTime()) <= 10 * 60_000 ? new Date(ts) : receivedAt;
}

export interface SessionTouch {
  channel: AttributionChannel;
  attribution: Attribution;
  clickId: string | null;
  paid: boolean;
  landingUrl: string | null;
}

/** The marketing touch a session represents, read from its first page (UTMs, click ids) and referrer. */
export function sessionTouch(url: string | null | undefined, referrer: string | null | undefined, storeHost?: string | null): SessionTouch {
  // a referrer on the store itself is internal navigation, not a source
  let ref = referrer ?? null;
  try {
    if (ref && url && new URL(ref).host === new URL(url).host) ref = null;
    if (ref && storeHost && new URL(ref).host === storeHost) ref = null;
  } catch {
    ref = null;
  }
  const attribution = extractAttribution({ landingSite: url ?? null, referringSite: ref, noteAttributes: [] });
  const channel = deriveChannel(attribution, ref);
  const clickId = Object.values(attribution.clickIds)[0] ?? null;
  return { channel, attribution, clickId, paid: channel === "paid_social" || channel === "paid_search", landingUrl: url ? url.slice(0, 2000) : null };
}
