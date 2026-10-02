import { replyMatches } from "@hullwise/core";
import type { CodSettings, TemplateVariable } from "./settings";

/** Fills `{{variable}}` placeholders; unknown or empty variables become an empty string, whitespace is tidied. */
export function renderTemplate(body: string, vars: Partial<Record<TemplateVariable, string | null | undefined>>): string {
  return body
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => (vars as Record<string, string | null | undefined>)[k] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Variables of a template body, in order of appearance, without duplicates. */
export function templateVariablesIn(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!))];
}

/** Lines for the warehouse: one `SKU × qty` per line (title when the line has no SKU), ancillary lines excluded. */
export function warehouseLines(lines: readonly { sku: string | null; title: string; variantTitle?: string | null; quantity: number; isAncillary?: boolean }[]): string {
  return lines
    .filter((l) => l.quantity > 0 && !l.isAncillary)
    .map((l) => `${l.sku?.trim() || `${l.title}${l.variantTitle ? ` ${l.variantTitle}` : ""}`} × ${l.quantity}`)
    .join("\n");
}

/** What a customer's reply to a confirmation message means for the queue: cancel wins when both match. */
export function classifyCodReply(text: string | null | undefined, replies: CodSettings["messagingReplies"]): "confirm" | "cancel" | null {
  if (replyMatches(text, replies.cancel)) return "cancel";
  if (replyMatches(text, replies.confirm)) return "confirm";
  return null;
}
