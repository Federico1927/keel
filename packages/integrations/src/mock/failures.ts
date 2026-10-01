import { IntegrationError } from "../types";

/**
 * Failure injection shared by the mock adapters: tests and the integrations page can
 * schedule the next call to fail with a realistic error, to exercise retries.
 */
export class FailureScript {
  private queue: IntegrationError["code"][] = [];
  failNext(code: IntegrationError["code"], times = 1) {
    for (let i = 0; i < times; i++) this.queue.push(code);
  }
  /** Throws if a failure is scheduled; otherwise no-op. */
  check(): void {
    const code = this.queue.shift();
    if (!code) return;
    switch (code) {
      case "rate_limited":
        throw new IntegrationError("rate_limited", "Mock: rate limit exceeded", 1200);
      case "token_expired":
        throw new IntegrationError("token_expired", "Mock: access token expired");
      case "permission":
        throw new IntegrationError("permission", "Mock: missing scope read_orders");
      case "network":
        throw new IntegrationError("network", "Mock: connection reset");
      default:
        throw new IntegrationError(code, `Mock: ${code}`);
    }
  }
  get pending(): number {
    return this.queue.length;
  }
}
