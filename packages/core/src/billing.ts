import { MODULES, PLANS, type PlanKey } from "@keel/config";

export interface InvoiceLine {
  kind: "plan" | "addon" | "setup";
  key: string;
  amountMinor: number;
}

/** Monthly charge for a plan plus its active, priced add-ons. */
export function monthlyInvoiceLines(planKey: PlanKey, activeAddons: readonly string[]): InvoiceLine[] {
  const plan = PLANS[planKey];
  const lines: InvoiceLine[] = [{ kind: "plan", key: planKey, amountMinor: plan.monthlyPriceMinor }];
  for (const key of activeAddons) {
    const def = MODULES[key as keyof typeof MODULES];
    if (def && def.monthlyPriceMinor) lines.push({ kind: "addon", key, amountMinor: def.monthlyPriceMinor });
  }
  return lines;
}

export function setupInvoiceLines(planKey: PlanKey): InvoiceLine[] {
  return [{ kind: "setup", key: planKey, amountMinor: PLANS[planKey].setupFeeMinor }];
}

export function sumLines(lines: readonly InvoiceLine[]): number {
  return lines.reduce((s, l) => s + l.amountMinor, 0);
}

export type PaymentHealth = "ok" | "past_due" | "suspended" | "none";

/** Payment health from open invoices: past due when any open invoice is overdue, suspended beyond the grace period. */
export function paymentHealth(invoices: readonly { status: string; dueAt: Date }[], now: Date, suspendAfterDays: number): { health: PaymentHealth; daysOverdue: number } {
  const open = invoices.filter((i) => i.status === "open");
  if (invoices.length === 0) return { health: "none", daysOverdue: 0 };
  const overdue = open.map((i) => Math.floor((now.getTime() - i.dueAt.getTime()) / 864e5)).filter((d) => d > 0);
  if (!overdue.length) return { health: "ok", daysOverdue: 0 };
  const worst = Math.max(...overdue);
  return { health: worst > suspendAfterDays ? "suspended" : "past_due", daysOverdue: worst };
}

/** Monthly recurring revenue across subscriptions that are billable (trialing counts at 0 until converted). */
export function mrr(subs: readonly { status: string; planKey: PlanKey; addons: readonly string[] }[]): number {
  return subs.filter((s) => s.status === "active" || s.status === "past_due").reduce((s, sub) => s + sumLines(monthlyInvoiceLines(sub.planKey, sub.addons)), 0);
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}
