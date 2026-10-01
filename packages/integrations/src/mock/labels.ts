import { createHash } from "node:crypto";
import type { Address, ReturnLabelProvider } from "../types";

/** Deterministic tracking code per reference; no label URL, so Keel renders the PDF itself. */
export class MockReturnLabelProvider implements ReturnLabelProvider {
  readonly provider = "mock";
  readonly calls: { reference: string; to: string }[] = [];
  async createLabel(input: { reference: string; from: Address | null; to: string; weightGrams: number | null }) {
    this.calls.push({ reference: input.reference, to: input.to });
    const digits = parseInt(createHash("sha256").update(input.reference).digest("hex").slice(0, 10), 16).toString().padStart(12, "0").slice(0, 12);
    return { carrier: "Mock Post", trackingCode: `MR${digits}`, labelUrl: null, qrCode: `MR${digits}` };
  }
}
