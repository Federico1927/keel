import type { PaymentGuarantee } from "../types";

/** Records holds, captures and voids; declines when the amount is above `declineAboveMinor`. */
export class MockPaymentGuarantee implements PaymentGuarantee {
  readonly provider = "mock";
  readonly calls: { op: string; args: unknown }[] = [];
  private seq = 0;
  constructor(private readonly opts: { declineAboveMinor?: number } = {}) {}
  async authorize(input: { amountMinor: number; currency: string; customerEmail: string | null; reference: string }) {
    this.calls.push({ op: "authorize", args: input });
    if (this.opts.declineAboveMinor !== undefined && input.amountMinor > this.opts.declineAboveMinor) return { authId: `mock-auth-${++this.seq}`, status: "failed" as const, actionUrl: null };
    return { authId: `mock-auth-${++this.seq}`, status: "authorized" as const, actionUrl: null };
  }
  async capture(authId: string, amountMinor?: number) {
    this.calls.push({ op: "capture", args: { authId, amountMinor } });
  }
  async void(authId: string) {
    this.calls.push({ op: "void", args: { authId } });
  }
}
