import type { ConnectionTest } from "../types";

/**
 * Accounting systems (`addon.accounting`, issue #85): Hullwise pushes one journal per closed day
 * built from the daily sales summary, reads its status back and voids it when a day is re-pushed.
 * Only the mock is implemented; live connectors (Xero, QuickBooks Online, Fatture in Cloud) are
 * built per account on request behind this interface.
 */
export const ACCOUNTING_PROVIDERS = ["accounting_mock"] as const;
/** Live systems a connector can be built for (catalog only, "available on request"). */
export const ACCOUNTING_CANDIDATE_PROVIDERS = ["xero", "quickbooks", "fatture_in_cloud"] as const;
/** The integration row of the add-on (`integrations.provider`). */
export const ACCOUNTING_INTEGRATION = "accounting";

export type AccountingAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export interface AccountingAccount {
  code: string;
  name: string;
  type: AccountingAccountType;
  /** Tax code the system attaches by default, when it has one. */
  taxCode: string | null;
  active: boolean;
}

export interface AccountingJournalLineInput {
  accountCode: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
}
export interface AccountingJournalInput {
  /** Local day of the journal (YYYY-MM-DD). */
  date: string;
  currency: string;
  narration: string;
  /** Hullwise's reference (tenant day and version), shown in the accounting system. */
  reference: string;
  status: "draft" | "posted";
  lines: AccountingJournalLineInput[];
}

export type AccountingJournalStatus = "draft" | "posted" | "voided" | "not_found";
export interface AccountingPushResult {
  externalId: string;
  status: AccountingJournalStatus;
  /** True when the system already had a journal for this idempotency key (nothing new was created). */
  replayed: boolean;
}

export interface AccountingProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  /** The chart of accounts (active and archived). */
  fetchAccounts(): Promise<AccountingAccount[]>;
  /** Creates the journal once per idempotency key; the same key returns the journal already created. */
  pushJournal(journal: AccountingJournalInput, opts: { idempotencyKey: string }): Promise<AccountingPushResult>;
  getJournalStatus(externalId: string): Promise<{ externalId: string; status: AccountingJournalStatus }>;
  /** Voids (reverses) a journal; voiding one already voided is a no-op. */
  voidJournal(externalId: string): Promise<void>;
}
