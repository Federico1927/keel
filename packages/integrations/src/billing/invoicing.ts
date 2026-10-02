/**
 * Italian e-invoicing slot (#53). An invoice Hullwise's company issues to an Italian customer must
 * also reach the tax authority's exchange system (SDI) as a FatturaPA XML, through an accredited
 * intermediary. This is the interface such a connector implements, with a mock; no real service is
 * wired. Go-live prerequisite for Italian customers (docs/DECISIONS.md, "Da verificare").
 */
export interface EInvoiceInput {
  invoiceNumber: string;
  externalInvoiceId: string;
  issuedAt: Date;
  currency: string;
  totalMinor: number;
  taxMinor: number;
  lines: { description: string; amountMinor: number }[];
  customer: { name: string; country: string | null; vatId: string | null; email: string | null };
}

export interface EInvoiceResult {
  /** Id at the intermediary, to follow the SDI outcome. */
  externalId: string;
  /** queued: handed over, SDI outcome pending · accepted · rejected */
  status: "queued" | "accepted" | "rejected";
}

export interface InvoicingProvider {
  readonly provider: string;
  pushInvoice(input: EInvoiceInput): Promise<EInvoiceResult>;
}

export class MockInvoicingProvider implements InvoicingProvider {
  readonly provider = "mock";
  readonly pushed: EInvoiceInput[] = [];
  async pushInvoice(input: EInvoiceInput): Promise<EInvoiceResult> {
    this.pushed.push(input);
    return { externalId: `mock_sdi_${input.invoiceNumber}`, status: "queued" };
  }
}
