import type { ModuleKey } from "./modules";

/** Delivery channels a user can switch per notification type. */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "slack"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationTypeDefinition {
  /** Channels this type can use at all (a digest is email only). */
  channels: readonly NotificationChannel[];
  /** What a user gets until they change it. */
  defaults: Partial<Record<NotificationChannel, boolean>>;
  /** Group shown on the preferences page. */
  group: "collaboration" | "operations" | "system";
  /** Shown only when the module is active for the tenant (add-on types). */
  module?: ModuleKey;
}

const ALL = NOTIFICATION_CHANNELS;

/**
 * Registry of notification types. The server resolves the channels of every delivery from this
 * table and the user's overrides (`notification_preferences`); unknown types fall back to in-app only.
 * Labels live in the translation files under `notifications.types.<type>`.
 */
export const NOTIFICATION_TYPES = {
  mention: { channels: ALL, defaults: { in_app: true, email: true }, group: "collaboration" },
  task_assigned: { channels: ALL, defaults: { in_app: true, email: true }, group: "collaboration" },
  task_due: { channels: ALL, defaults: { in_app: true }, group: "collaboration" },
  support_reply: { channels: ["in_app", "email"], defaults: { in_app: true, email: true }, group: "collaboration" },
  alert: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  sync_delay: { channels: ALL, defaults: { in_app: true }, group: "system" },
  stock_critical_no_po: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  late_to_ship: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  stock_low: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  stock_available: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  return_portal: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  po_supplier_confirmed: { channels: ALL, defaults: { in_app: true }, group: "operations" },
  po_supplier_problem: { channels: ALL, defaults: { in_app: true, email: true }, group: "operations" },
  integration_health: { channels: ALL, defaults: { in_app: true }, group: "system" },
  cod_assigned: { channels: ["in_app", "email"], defaults: { in_app: true }, group: "operations", module: "addon.cod" },
  digest: { channels: ["email"], defaults: { email: false }, group: "system" },
  export_ready: { channels: ["in_app", "email"], defaults: { in_app: true }, group: "system" },
} as const satisfies Record<string, NotificationTypeDefinition>;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function isNotificationType(v: unknown): v is NotificationType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, v);
}

/** Types a tenant can see on the preferences page (add-on types only with the add-on). */
export function notificationTypesFor(activeAddons: readonly string[]): NotificationType[] {
  return (Object.keys(NOTIFICATION_TYPES) as NotificationType[]).filter((k) => {
    const def: NotificationTypeDefinition = NOTIFICATION_TYPES[k];
    return !def.module || activeAddons.includes(def.module);
  });
}

/**
 * Effective channels for one type given the user's overrides. Overrides on channels the type
 * cannot use are ignored; unknown types get in-app only.
 */
export function resolveNotificationChannels(type: string, overrides: Partial<Record<NotificationChannel, boolean>> = {}): Record<NotificationChannel, boolean> {
  const def: NotificationTypeDefinition | undefined = isNotificationType(type) ? NOTIFICATION_TYPES[type] : undefined;
  const allowed = def?.channels ?? ["in_app"];
  const defaults = def?.defaults ?? { in_app: true };
  const out = { in_app: false, email: false, slack: false } as Record<NotificationChannel, boolean>;
  for (const c of allowed) out[c] = overrides[c] ?? defaults[c] ?? false;
  return out;
}

/** Support attachments and email categories. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 1_500_000;
export const SUPPORT_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv"] as const;
