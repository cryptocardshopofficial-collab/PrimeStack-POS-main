/**
 * SWIFT MT message parsing types.
 *
 * Covers the two message types a payment hub needs first:
 *   MT103 — single customer credit transfer (ordering customer → beneficiary)
 *   MT202 — general financial institution transfer (bank → bank settlement)
 */

export type SwiftMessageType = "MT103" | "MT202";

/** Raw tag → value map from block 4 (:20:, :32A:, …). */
export type SwiftFieldMap = Record<string, string>;

export interface SwiftAmountField {
  /** ISO date derived from the YYMMDD component of :32A:. */
  valueDate: string | null;
  /** ISO 4217 code from :32A:. */
  currency: string;
  /** Normalised decimal amount, always two decimal places. */
  amount: string;
}

export interface SwiftParty {
  /** Account, when the field carries one (leading `/` line). */
  account: string | null;
  /** BIC when present — :50A:/:59A: carry it on its own line. */
  bic: string | null;
  /** Primary name line. */
  name: string | null;
  /** Remaining name/address lines in order. */
  address: string[];
  /** The untouched field value, newlines preserved. */
  raw: string;
}

export interface ParsedSwiftMessage {
  messageType: SwiftMessageType;
  /** :20: sender's reference (also the payment reference for MT103). */
  reference: string | null;
  /** :23B: bank operation code — MT103 only (CRED, SPRI, …). */
  operationCode: string | null;
  /** :21: related reference — MT202 only. */
  relatedReference: string | null;
  valueDate: string | null;
  currency: string | null;
  amount: string | null;
  /** :50K:/:50A:/:50F: ordering customer — MT103 only. */
  orderingCustomer: SwiftParty | null;
  /** :59:/:59A: beneficiary customer — MT103 only. */
  beneficiary: SwiftParty | null;
  /** :52A:/:52D: ordering institution — MT202 (and sometimes MT103). */
  orderingInstitution: SwiftParty | null;
  /** :58A:/:58D: beneficiary institution — MT202 only. */
  beneficiaryInstitution: SwiftParty | null;
  /** :70: remittance information. */
  paymentDetails: string | null;
  /** :71A: details of charges (BEN / OUR / SHA) — MT103 only. */
  charges: string | null;
  /** :72: sender-to-receiver information. */
  senderToReceiverInfo: string | null;
  senderBic: string | null;
  receiverBic: string | null;
  /** Every block-4 field exactly as received. */
  fields: SwiftFieldMap;
}

export interface SwiftValidationIssue {
  /** The SWIFT tag the issue relates to, e.g. ":32A:". */
  tag: string;
  code: string;
  message: string;
}

export interface SwiftParseResult {
  /** Null when the message type could not be determined. */
  messageType: SwiftMessageType | null;
  parsed: ParsedSwiftMessage | null;
  valid: boolean;
  errors: SwiftValidationIssue[];
  warnings: SwiftValidationIssue[];
  /** Block 1 / 2 / 3 header values when the message carried any. */
  header: {
    senderBic: string | null;
    receiverBic: string | null;
    inputOutput: "INPUT" | "OUTPUT" | null;
  };
}
