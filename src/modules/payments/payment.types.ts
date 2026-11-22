/**
 * Payment ingestion types.
 *
 * The ingestion pipeline drives an incoming payment through:
 *   parse -> sanctions -> fraud -> resolve -> ledger post -> notify.
 *
 * Every state transition is persisted on the IncomingPayment record and emits
 * a stream event, so a replayed or retried message is deterministic.
 */

import type { PaymentRail, PaymentStatus } from "@prisma/client";

/** A party extracted from an inbound message (debtor or creditor). */
export interface PaymentParty {
  name: string | null;
  account: string | null;
  bic: string | null;
  country: string | null;
}

/** Normalised payment shape produced by the parser or supplied directly. */
export interface ParsedPayment {
  rail: PaymentRail;
  reference: string;
  amount: string;
  currency: string;
  valueDate: string | null;
  operationCode: string | null;
  charges: string | null;
  debtor: PaymentParty;
  creditor: PaymentParty;
  /** Optional raw message for audit (not logged at info level). */
  raw?: string;
}

/** Input to the ingest endpoint. */
export interface IngestInput {
  /** A raw SWIFT MT103/MT202 message — parsed by the SWIFT MT module. */
  rawMessage?: string;
  /** A pre-parsed payment (skips the parser). */
  payment?: ParsedPayment;
  /** Optional destination merchant id — overrides creditor-account matching. */
  merchantId?: string;
}

/** Result returned by the ingestion pipeline. */
export interface IngestResult {
  /** True when the payment was newly created; false on idempotent replay. */
  created: boolean;
  payment: {
    id: string;
    reference: string;
    rail: PaymentRail;
    status: PaymentStatus;
    amount: string;
    currency: string;
    merchantId: string | null;
    walletId: string | null;
    journalEntryRef: string | null;
    fraudVerdict: string | null;
    failureReason: string | null;
    createdAt: Date;
  };
}

/** Operator decision on a payment held for review or assignment. */
export type ResolveDecision = "APPROVE" | "REJECT";

export interface ResolveInput {
  decision: ResolveDecision;
  reviewedBy: string;
  reviewNotes?: string;
  /** When approving, optionally assign a merchant id if not yet resolved. */
  merchantId?: string;
}

/** Filters for listing incoming payments. */
export interface ListPaymentsFilters {
  status?: PaymentStatus;
  rail?: PaymentRail;
  merchantId?: string;
  page: number;
  pageSize: number;
}
