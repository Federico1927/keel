import type { PoVariantOption } from "@keel/services";

/** Line model of the PO editor; shared by the server pages that pre-fill it and the client editor. */
export interface EditorLine {
  key: string;
  variantId: string | null;
  label: string;
  sku: string | null;
  description: string;
  quantity: string;
  unitCost: string;
  risk: string | null;
  daysOfCover: number | null;
  available: number | null;
}

export interface EditorInitial {
  supplierId: string;
  destinationLocationId: string;
  expectedAt: string;
  notes: string;
  lines: EditorLine[];
}

let seq = 0;
export const newLineKey = () => `l${++seq}-${Math.random().toString(36).slice(2, 7)}`;

/** Cost for a new line: the supplier's agreed cost when it is the variant's default supplier, else the last cost. */
function defaultCost(o: PoVariantOption, supplierId: string): string {
  const minor = o.supplierId === supplierId && o.supplierCostMinor !== null ? o.supplierCostMinor : (o.costMinor ?? 0);
  return (minor / 100).toFixed(2);
}

export function lineFromOption(o: PoVariantOption, supplierId: string, quantity: number): EditorLine {
  return { key: newLineKey(), variantId: o.variantId, label: o.label, sku: o.sku, description: "", quantity: String(quantity), unitCost: defaultCost(o, supplierId), risk: o.risk, daysOfCover: o.daysOfCover, available: o.available };
}

