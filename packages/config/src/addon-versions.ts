import { ADDON_MODULES, MODULES, type AddonModule } from "./modules";

/**
 * Add-on versions (#77). An add-on can be activated for a tenant only when one of its versions is
 * `released`: built, verified and able to do its job without anything still under construction.
 * `in_development` versions are shown in the console but cannot be activated. Add-ons available
 * only on request (catalog entries) have no versions.
 *
 * Release a version by flipping its status here; start the next one by appending it as
 * `in_development`. Older released versions can be dropped from the list: the console shows at
 * most the current released version and the work in progress.
 */
export type AddonVersionStatus = "released" | "in_development";

export interface AddonVersion {
  /** Shown as "v1", "v2"… */
  version: number;
  status: AddonVersionStatus;
  /** i18n key (under `modules.`) for one line on what this version does or still lacks. */
  summaryKey: string;
}

export const ADDON_VERSIONS: Record<AddonModule, readonly AddonVersion[]> = {
  // v1: confirmation queue, outcomes and attempts, weighted assignment, delivery score, recipient risk, settings.
  // v2: messages to recipients through a real WhatsApp/SMS provider (today only the mock channel).
  "addon.cod": [
    { version: 1, status: "released", summaryKey: "addon.cod.v1" },
    { version: 2, status: "in_development", summaryKey: "addon.cod.v2" },
  ],
  // v1: approval, scheduling, send queue, control groups and uplift; sends only through the mock channel.
  "addon.customer_campaigns": [{ version: 1, status: "in_development", summaryKey: "addon.customer_campaigns.v1" }],
  // v1: Shopify Subscriptions, Recharge and Loop adapters tested only on recorded fixtures; no live provider verified yet.
  "addon.subscriptions": [{ version: 1, status: "in_development", summaryKey: "addon.subscriptions.v1" }],
  "addon.warehouse_3pl": [],
  "addon.whatsapp": [],
  "addon.carrier_tracking": [],
};

/** Highest released version, or null when nothing can be activated yet. */
export function releasedVersion(key: AddonModule): AddonVersion | null {
  const released = ADDON_VERSIONS[key].filter((v) => v.status === "released");
  return released.length ? released.reduce((a, b) => (b.version > a.version ? b : a)) : null;
}

/** Highest version still in development above the released one, or null. */
export function wipVersion(key: AddonModule): AddonVersion | null {
  const floor = releasedVersion(key)?.version ?? 0;
  const wip = ADDON_VERSIONS[key].filter((v) => v.status === "in_development" && v.version > floor);
  return wip.length ? wip.reduce((a, b) => (b.version > a.version ? b : a)) : null;
}

/** What the console shows for an add-on: at most the current released version and the work in progress. */
export function displayedVersions(key: AddonModule): AddonVersion[] {
  return [releasedVersion(key), wipVersion(key)].filter((v): v is AddonVersion => v !== null);
}

/** Whether the super-admin may switch the add-on on for a tenant. Switching off is always allowed. */
export function canActivateAddon(key: AddonModule): boolean {
  return MODULES[key].availability === "implemented" && releasedVersion(key) !== null;
}

/** Add-ons that can be activated today (billing, subscriptions, the console's choices). */
export function activatableAddons(): AddonModule[] {
  return ADDON_MODULES.filter(canActivateAddon);
}

/**
 * Whether an active add-on is charged: only a released, priced add-on. An add-on switched on before
 * its release stays usable but is not billed (invoices, Stripe items, MRR, catalog) until a version ships.
 */
export function isBillableAddon(key: string): boolean {
  return (ADDON_MODULES as readonly string[]).includes(key) && canActivateAddon(key as AddonModule) && Boolean(MODULES[key as AddonModule].monthlyPriceMinor);
}
