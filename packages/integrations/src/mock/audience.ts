import type { AudienceDestination, AudienceMatchKeys, AudienceProvider, ConnectionTest } from "../types";
import { FailureScript } from "./failures";

/** In-memory audiences keyed by customer, so tests can assert exactly who is in each list. */
export class MockAudienceDestination implements AudienceDestination {
  readonly failures = new FailureScript();
  readonly audiences = new Map<string, { name: string; members: Map<string, Record<string, string>> }>();
  constructor(readonly provider: AudienceProvider) {}
  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: `Mock ${this.provider}` };
  }
  async ensureAudience(name: string, existingId: string | null) {
    this.failures.check();
    if (existingId && this.audiences.has(existingId)) return { audienceId: existingId };
    const audienceId = existingId ?? `mock-aud-${this.audiences.size + 1}`;
    this.audiences.set(audienceId, { name, members: new Map() });
    return { audienceId };
  }
  async addMembers(audienceId: string, members: AudienceMatchKeys[]) {
    this.failures.check();
    const a = this.audiences.get(audienceId) ?? { name: audienceId, members: new Map() };
    for (const m of members) a.members.set(m.customerId, m.keys);
    this.audiences.set(audienceId, a);
    return { accepted: members.length };
  }
  async removeMembers(audienceId: string, members: AudienceMatchKeys[]) {
    this.failures.check();
    const a = this.audiences.get(audienceId);
    let removed = 0;
    for (const m of members) if (a?.members.delete(m.customerId)) removed++;
    return { removed };
  }
}
