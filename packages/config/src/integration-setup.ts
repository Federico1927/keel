/**
 * Merchant self-setup checklists (#86, shared with the Shopify setup of #89): what an integration card
 * shows so a store connects on its own. Plain data: the card renders the steps in order from message
 * keys under `namespace`, offers a copy button for each `copy` value it resolves at render time
 * (an e-mail, a URL), marks vendor-UI steps with the "To verify" badge, and turns a failed test into
 * the message and fix of its error code.
 */
export interface IntegrationSetupStep {
  key: string;
  /** Message key of the step, under the guide's namespace. */
  messageKey: string;
  /** Name of a value the card resolves and shows with a copy button (e.g. `serviceAccountEmail`). */
  copy?: string;
  /** Points into the vendor's UI, which may have changed: shown with the "To verify" badge. */
  verify?: boolean;
  /** The step where the merchant types the value the connection needs (rendered as the form field). */
  input?: string;
}

export interface IntegrationSetupGuide<E extends string = string> {
  provider: string;
  /** i18n namespace of every key below. */
  namespace: string;
  titleKey: string;
  steps: readonly IntegrationSetupStep[];
  /** Plain-words outcome of a failed test → message and fix keys. */
  errors: Readonly<Record<E, { messageKey: string; fixKey: string }>>;
  /** The manual path for stores that bring their own credentials. */
  advancedKey?: string;
}

/** GA4 with the platform's service account (default): add the e-mail as Viewer, paste the property id, connect. */
export const GA4_SETUP = {
  provider: "ga4",
  namespace: "ga4.setup",
  titleKey: "title",
  steps: [
    { key: "open_admin", messageKey: "steps.open_admin", verify: true },
    { key: "access", messageKey: "steps.access", verify: true },
    { key: "add_viewer", messageKey: "steps.add_viewer", copy: "serviceAccountEmail", verify: true },
    { key: "property_id", messageKey: "steps.property_id", verify: true },
    { key: "paste", messageKey: "steps.paste", input: "propertyId" },
    { key: "connect", messageKey: "steps.connect" },
  ],
  errors: {
    no_access: { messageKey: "errors.no_access.message", fixKey: "errors.no_access.fix" },
    wrong_property: { messageKey: "errors.wrong_property.message", fixKey: "errors.wrong_property.fix" },
    api_unreachable: { messageKey: "errors.api_unreachable.message", fixKey: "errors.api_unreachable.fix" },
    quota: { messageKey: "errors.quota.message", fixKey: "errors.quota.fix" },
    credentials: { messageKey: "errors.credentials.message", fixKey: "errors.credentials.fix" },
    unknown: { messageKey: "errors.unknown.message", fixKey: "errors.unknown.fix" },
  },
  advancedKey: "advanced",
} as const satisfies IntegrationSetupGuide<"no_access" | "wrong_property" | "api_unreachable" | "quota" | "credentials" | "unknown">;
