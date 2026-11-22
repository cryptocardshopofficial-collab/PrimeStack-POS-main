import { parseSwiftMessage, validateMessage } from "./swift-mt.parser.js";
import type {
  ParsedSwiftMessage,
  SwiftMessageType,
  SwiftParseResult,
  SwiftParty,
} from "./swift-mt.types.js";

/**
 * Normalised party view used by the payment hub, so a SWIFT party and an
 * ISO 20022 party can be compared side by side.
 */
export interface SwiftPartySummary {
  name: string | null;
  account: string | null;
  bic: string | null;
  country: string | null;
  address: string[];
}

export interface SwiftPaymentSummary {
  messageType: SwiftMessageType;
  rail: "SWIFT_MT103" | "SWIFT_MT202";
  reference: string | null;
  relatedReference: string | null;
  valueDate: string | null;
  currency: string | null;
  amount: string | null;
  operationCode: string | null;
  charges: string | null;
  debtor: SwiftPartySummary | null;
  creditor: SwiftPartySummary | null;
  institution: SwiftPartySummary | null;
}

export interface SwiftParseOutcome extends SwiftParseResult {
  /** Hub-shaped summary — null when the message could not be parsed. */
  payment: SwiftPaymentSummary | null;
}

/**
 * Stateless SWIFT MT parser service.
 *
 * Parsing is pure: nothing is persisted, so an operator can paste a message
 * from a bank portal and inspect it without creating an audit trail that
 * implies the message was ingested.
 */
export class SwiftMtService {
  parse(raw: string, options: { messageType?: SwiftMessageType } = {}): SwiftParseOutcome {
    if (typeof raw !== "string" || raw.trim() === "") {
      return {
        messageType: null,
        parsed: null,
        valid: false,
        errors: [{ tag: ":4:", code: "EMPTY_MESSAGE", message: "message is required" }],
        warnings: [],
        header: { senderBic: null, receiverBic: null, inputOutput: null },
        payment: null,
      };
    }

    const result = parseSwiftMessage(raw, options);
    return {
      ...result,
      payment: result.parsed ? this.toPaymentSummary(result.parsed) : null,
    };
  }

  /** Re-validate an already-parsed message. */
  validate(parsed: ParsedSwiftMessage) {
    const { errors, warnings } = validateMessage(parsed);
    return { valid: errors.length === 0, errors, warnings };
  }

  toPaymentSummary(parsed: ParsedSwiftMessage): SwiftPaymentSummary {
    if (parsed.messageType === "MT103") {
      return {
        messageType: "MT103",
        rail: "SWIFT_MT103",
        reference: parsed.reference,
        relatedReference: null,
        valueDate: parsed.valueDate,
        currency: parsed.currency,
        amount: parsed.amount,
        operationCode: parsed.operationCode,
        charges: parsed.charges,
        debtor: toSummary(parsed.orderingCustomer),
        creditor: toSummary(parsed.beneficiary),
        institution: toSummary(parsed.receiverBic ? { account: null, bic: parsed.receiverBic, name: null, address: [], raw: "" } : null),
      };
    }

    return {
      messageType: "MT202",
      rail: "SWIFT_MT202",
      reference: parsed.reference,
      relatedReference: parsed.relatedReference,
      valueDate: parsed.valueDate,
      currency: parsed.currency,
      amount: parsed.amount,
      operationCode: null,
      charges: null,
      debtor: toSummary(parsed.orderingInstitution),
      creditor: toSummary(parsed.beneficiaryInstitution),
      institution: toSummary(parsed.beneficiaryInstitution),
    };
  }

  /** Metadata for the dashboard: supported types and their mandatory fields. */
  describeTypes() {
    return [
      {
        messageType: "MT103" as const,
        name: "Single Customer Credit Transfer",
        purpose: "Sender to receiver payment details for a customer credit transfer",
        requiredFields: [":20:", ":23B:", ":32A:", ":50K: (or :50A:/:50F:)", ":59: (or :59A:)", ":71A:"],
        optionalFields: [":33B:", ":52A:", ":53A:", ":57A:", ":70:", ":71F:", ":72:"],
      },
      {
        messageType: "MT202" as const,
        name: "General Financial Institution Transfer",
        purpose: "Bank to bank settlement, correspondent banking and liquidity transfers",
        requiredFields: [":20:", ":21:", ":32A:", ":58A: (or :58D:)"],
        optionalFields: [":52A:", ":53A:", ":56A:", ":57A:", ":72:"],
      },
    ];
  }
}

function toSummary(party: SwiftParty | null): SwiftPartySummary | null {
  if (!party) return null;
  return {
    name: party.name,
    account: party.account,
    bic: party.bic,
    country: countryFromBic(party.bic),
    address: party.address,
  };
}

/** BIC characters 5–6 are the ISO country code. */
function countryFromBic(bic: string | null): string | null {
  if (!bic || bic.length < 6) return null;
  return bic.slice(4, 6);
}
