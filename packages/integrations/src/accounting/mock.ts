import { IntegrationError, type ConnectionTest } from "../types";
import { FailureScript } from "../mock/failures";
import type { AccountingAccount, AccountingJournalInput, AccountingJournalStatus, AccountingProvider, AccountingPushResult } from "./types";

/** A small generic chart of accounts (no country's numbering): the demo and tests map against it. */
export const MOCK_CHART_OF_ACCOUNTS: readonly AccountingAccount[] = [
  { code: "1100", name: "Payment processors clearing", type: "asset", taxCode: null, active: true },
  { code: "1200", name: "Bank", type: "asset", taxCode: null, active: true },
  { code: "2200", name: "Sales tax payable", type: "liability", taxCode: null, active: true },
  { code: "2210", name: "Sales tax payable (reduced rates)", type: "liability", taxCode: null, active: true },
  { code: "4000", name: "Sales", type: "revenue", taxCode: "OUTPUT", active: true },
  { code: "4010", name: "Sales (reduced and zero rates)", type: "revenue", taxCode: "OUTPUT2", active: true },
  { code: "4020", name: "Sales (exports)", type: "revenue", taxCode: "EXEMPT", active: true },
  { code: "4090", name: "Shipping income", type: "revenue", taxCode: "OUTPUT", active: true },
  { code: "4900", name: "Discounts given", type: "revenue", taxCode: null, active: true },
  { code: "4910", name: "Refunds and returns", type: "revenue", taxCode: null, active: true },
  { code: "6100", name: "Payment processing fees", type: "expense", taxCode: null, active: true },
  { code: "6900", name: "Old suspense account", type: "asset", taxCode: null, active: false },
];

interface MockJournal {
  externalId: string;
  journal: AccountingJournalInput;
  status: AccountingJournalStatus;
}

/**
 * In-memory accounting system: validates like a real one (balanced, known active accounts, one
 * currency), honours idempotency keys, records voids, and fails on request (`failures`) so retries
 * can be exercised. Journals it did not create in this process but carrying its id format (seeded
 * history, another process) are treated as existing posted journals.
 */
export class MockAccountingProvider implements AccountingProvider {
  readonly provider = "accounting_mock";
  readonly failures = new FailureScript();
  readonly journals = new Map<string, MockJournal>();
  readonly voided: string[] = [];
  private readonly byKey = new Map<string, string>();
  private seq = 0;
  constructor(private readonly opts: { accountName?: string; accounts?: readonly AccountingAccount[] } = {}) {}

  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: this.opts.accountName ?? "Simulated accounting system", accountId: "mock-books" };
  }

  async fetchAccounts(): Promise<AccountingAccount[]> {
    this.failures.check();
    return [...(this.opts.accounts ?? MOCK_CHART_OF_ACCOUNTS)];
  }

  async pushJournal(journal: AccountingJournalInput, opts: { idempotencyKey: string }): Promise<AccountingPushResult> {
    this.failures.check();
    const known = this.byKey.get(opts.idempotencyKey);
    if (known) return { externalId: known, status: this.journals.get(known)!.status, replayed: true };
    const accounts = new Map((this.opts.accounts ?? MOCK_CHART_OF_ACCOUNTS).map((a) => [a.code, a]));
    const debit = journal.lines.reduce((s, l) => s + l.debitMinor, 0);
    const credit = journal.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (!journal.lines.length) throw new IntegrationError("invalid_request", "Mock: a journal needs at least one line");
    if (debit !== credit) throw new IntegrationError("invalid_request", `Mock: journal does not balance (debits ${debit}, credits ${credit})`);
    const bad = journal.lines.find((l) => !accounts.get(l.accountCode)?.active);
    if (bad) throw new IntegrationError("invalid_request", `Mock: account ${bad.accountCode} does not exist or is archived`);
    const externalId = `mock-jnl-${String(++this.seq).padStart(5, "0")}-${journal.date}`;
    this.journals.set(externalId, { externalId, journal, status: journal.status });
    this.byKey.set(opts.idempotencyKey, externalId);
    return { externalId, status: journal.status, replayed: false };
  }

  async getJournalStatus(externalId: string): Promise<{ externalId: string; status: AccountingJournalStatus }> {
    this.failures.check();
    const j = this.journals.get(externalId);
    if (j) return { externalId, status: j.status };
    if (this.voided.includes(externalId)) return { externalId, status: "voided" };
    return { externalId, status: externalId.startsWith("mock-jnl-") ? "posted" : "not_found" };
  }

  async voidJournal(externalId: string): Promise<void> {
    this.failures.check();
    const j = this.journals.get(externalId);
    if (!j && !externalId.startsWith("mock-jnl-")) throw new IntegrationError("not_found", `Mock: journal ${externalId} not found`);
    if (j) j.status = "voided";
    if (!this.voided.includes(externalId)) this.voided.push(externalId);
  }
}
