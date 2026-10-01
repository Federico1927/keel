/**
 * Types whose title/body are data rendered through `notifications.rendered.<type>`: counts for the
 * grouped stock and shipping alerts (only when the title is a number, so other emitters of the same
 * type can send plain text), the source name for sync delays.
 */
const COUNTED = new Set(["stock_critical_no_po", "late_to_ship"]);
const EXPORT_LISTS = new Set(["orders", "products", "returns", "customers"]);

export function usesRenderedText(n: { type: string; title: string }): boolean {
  return n.type === "sync_delay" || (COUNTED.has(n.type) && /^\d+$/.test(n.title));
}

/** Localized title and body of a notification row; works with the server and the client translator. */
export function notificationText(t: (key: string, values?: Record<string, string>) => string, n: { type: string; title: string; body: string | null }): { title: string; body: string | null } {
  // background CSV exports: title = row count (or "failed"), body = list key
  if (n.type === "export_ready" && EXPORT_LISTS.has(n.body ?? "")) {
    const list = t(`export_lists.${n.body}`);
    return { title: /^\d+$/.test(n.title) ? t("rendered.export_ready", { title: n.title, body: list }) : t("rendered.export_failed", { body: list }), body: null };
  }
  if (usesRenderedText(n)) return { title: t(`rendered.${n.type}`, { title: n.title, body: n.body ?? "" }), body: null };
  // mentions store the raw note: show @Name instead of the inline id
  return { title: n.title, body: n.body ? n.body.replace(/@\[([^\]]{1,80})\]\([0-9a-f-]{36}\)/gi, "@$1") : null };
}
