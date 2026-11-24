import { randomUUID } from "crypto";
import { prisma } from "../../core/database.js";
import { config } from "../../config/index.js";
import { Decimal } from "../../core/decimal.js";
import {
  ForbiddenError,
  InsufficientFundsError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { generateReference } from "../../shared/utils/crypto.js";
import {
  getWiseBalance,
  isWiseProvisioningEnabled,
  wiseRequest,
} from "./wise-virtual-account.js";
import {
  ensurePlatformReserve,
  ensureSupeFundingAccount,
} from "./wise-webhook.handler.js";

/**
 * Wise outbound payout rail.
 *
 * Sends funds OUT of the platform's Wise balance to an external bank account.
 * This is the mirror of the inbound `balances#update` handler: an inbound credit
 * debits SYSTEM-FUNDING and credits PLATFORM:RESERVE, so an outbound payout
 * debits PLATFORM:RESERVE and credits SYSTEM-FUNDING.
 *
 * USD only, per the enabled rail.
 */
const SUPPORTED_PAYOUT_CURRENCY = "USD";
const MAX_PAYOUT_AMOUNT = "10000000";

export interface WiseBankAddress {
  firstLine: string;
  city: string;
  state?: string;
  postCode: string;
  country: string;
}

export interface WiseBankRecipientInput {
  accountHolderName: string;
  /** US ACH routing number. Supply this OR `swiftCode`. */
  routingNumber?: string;
  accountNumber?: string;
  /** International SWIFT/BIC. Supply this OR `routingNumber`. */
  swiftCode?: string;
  iban?: string;
  accountType?: "CHECKING" | "SAVINGS";
  /** ISO-3166 alpha-2 country of the beneficiary bank. */
  country: string;
  address: WiseBankAddress;
}

export interface WisePayoutInput {
  amount: string;
  currency?: string;
  recipient: WiseBankRecipientInput;
  reference?: string;
  description?: string;
  postedBy: string;
}

export interface WisePayoutResult {
  reference: string;
  status: "SENT";
  currency: string;
  amount: string;
  wiseRecipientId: string;
  wiseQuoteId: string;
  wiseTransferId: string;
  journalEntryRef: string;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function requireWiseProfileId(): string {
  if (!isWiseProvisioningEnabled()) {
    throw new ForbiddenError(
      "Wise outbound payouts are not enabled or fully configured",
    );
  }
  return config.wise.profileId;
}

/**
 * Builds the Wise recipient payload, choosing the recipient type from the
 * details supplied: a routing number means a US (ACH) recipient, a SWIFT code
 * means an international one.
 */
function buildRecipientPayload(recipient: WiseBankRecipientInput): {
  type: string;
  details: Record<string, unknown>;
} {
  const address = {
    country: recipient.address.country,
    city: recipient.address.city,
    firstLine: recipient.address.firstLine,
    postCode: recipient.address.postCode,
    ...(recipient.address.state ? { state: recipient.address.state } : {}),
  };

  if (recipient.routingNumber) {
    if (!recipient.accountNumber) {
      throw new ValidationError(
        "accountNumber is required for a US (ACH) recipient",
      );
    }
    return {
      type: "aba",
      details: {
        abartn: recipient.routingNumber,
        accountNumber: recipient.accountNumber,
        accountType: recipient.accountType ?? "CHECKING",
        address,
      },
    };
  }

  if (recipient.swiftCode) {
    const account = recipient.iban ?? recipient.accountNumber;
    if (!account) {
      throw new ValidationError(
        "accountNumber or iban is required for an international (SWIFT) recipient",
      );
    }
    return {
      type: "swift_code",
      details: {
        swiftCode: recipient.swiftCode,
        accountNumber: account,
        country: recipient.country,
        address,
      },
    };
  }

  throw new ValidationError(
    "A routingNumber (US ACH) or swiftCode (international) is required",
  );
}

async function createWiseRecipient(
  profileId: string,
  currency: string,
  recipient: WiseBankRecipientInput,
): Promise<string> {
  const { type, details } = buildRecipientPayload(recipient);
  // Wise expects the numeric profile id in the body.
  const profileRef = Number.isNaN(Number(profileId)) ? profileId : Number(profileId);
  const created = await wiseRequest<unknown>("POST", "/v2/accounts", {
    profile: profileRef,
    currency,
    type,
    accountHolderName: recipient.accountHolderName,
    ownedByCustomer: false,
    details,
  });
  const id = safeText(asRecord(created).id);
  if (!id) throw new ValidationError("Wise did not return a recipient id");
  return id;
}

async function createWiseQuote(
  recipientId: string,
  currency: string,
  amount: string,
): Promise<string> {
  const quote = await wiseRequest<unknown>("POST", "/v3/quotes", {
    sourceCurrency: currency,
    targetCurrency: currency,
    sourceAmount: Number(amount),
    targetAccount: recipientId,
    payOut: "BANK_TRANSFER",
    preferredPayIn: "BALANCE",
  });
  const id = safeText(asRecord(quote).id);
  if (!id) throw new ValidationError("Wise did not return a quote id");
  return id;
}

async function createWiseTransfer(
  recipientId: string,
  quoteId: string,
  reference: string,
): Promise<string> {
  const transfer = await wiseRequest<unknown>("POST", "/v1/transfers", {
    targetAccount: recipientId,
    quoteUuid: quoteId,
    customerTransactionId: randomUUID(),
    details: { reference },
  });
  const id = safeText(asRecord(transfer).id);
  if (!id) throw new ValidationError("Wise did not return a transfer id");
  return id;
}

/** Funds a queued transfer from the profile's Wise balance and returns its status. */
async function fundWiseTransfer(
  profileId: string,
  transferId: string,
): Promise<string> {
  const funded = await wiseRequest<unknown>(
    "POST",
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    { type: "BALANCE" },
  );
  return safeText(asRecord(funded).status) || "PROCESSING";
}

/**
 * Executes a USD outbound payout from the platform's Wise balance to an
 * external bank account.
 *
 * Fail-closed ordering: the ledger debit is posted before any money leaves
 * Wise, and is reversed if Wise rejects the payout — so the books never record
 * a payout that did not happen, and money never leaves without a ledger record.
 */
export async function executeWisePayout(
  input: WisePayoutInput,
): Promise<WisePayoutResult> {
  const profileId = requireWiseProfileId();

  const currency = (input.currency ?? SUPPORTED_PAYOUT_CURRENCY).toUpperCase();
  if (currency !== SUPPORTED_PAYOUT_CURRENCY) {
    throw new ValidationError(
      `Only ${SUPPORTED_PAYOUT_CURRENCY} payouts are supported`,
    );
  }

  const amount = new Decimal(input.amount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new ValidationError("Payout amount must be positive");
  }
  if (amount.gt(MAX_PAYOUT_AMOUNT)) {
    throw new ValidationError("Payout amount exceeds the maximum limit");
  }

  // Preflight — only send what the Wise balance actually holds.
  const balance = await getWiseBalance(currency);
  if (!balance) {
    throw new ValidationError(
      `No Wise ${currency} balance is available to pay from`,
    );
  }
  if (new Decimal(balance.amount).lt(amount)) {
    throw new InsufficientFundsError(
      `WISE:${currency}`,
      balance.amount,
      amount.toString(),
    );
  }

  const reserveCode = await ensurePlatformReserve(prisma, currency);
  const fundingCode = await ensureSupeFundingAccount(prisma, currency);

  const reference = generateReference("WPAY");
  const journalRef = `JE-${reference}`;

  // 1. Record the outflow first (fail-closed).
  await ledgerService.postEntry({
    reference: journalRef,
    entryType: "PAYOUT",
    description:
      input.description ??
      `Wise payout to ${input.recipient.accountHolderName}`,
    source: "WISE_PAYOUT",
    postedBy: input.postedBy,
    metadata: {
      provider: "WISE",
      recipient: input.recipient.accountHolderName,
      currency,
      amount: amount.toString(),
      externalReference: input.reference ?? null,
      wiseBalanceId: balance.balanceId,
      initiatedAt: new Date().toISOString(),
    },
    lines: [
      { accountCode: reserveCode, debit: amount.toString(), credit: "0" },
      { accountCode: fundingCode, debit: "0", credit: amount.toString() },
    ],
  });

  // 2. Send the money, reversing the ledger record on any failure.
  try {
    const recipientId = await createWiseRecipient(
      profileId,
      currency,
      input.recipient,
    );
    const quoteId = await createWiseQuote(
      recipientId,
      currency,
      amount.toString(),
    );
    const transferId = await createWiseTransfer(
      recipientId,
      quoteId,
      input.reference ?? reference,
    );
    const wiseStatus = await fundWiseTransfer(profileId, transferId);

    logger.info(
      {
        reference,
        journalRef,
        amount: amount.toString(),
        currency,
        recipientId,
        transferId,
        wiseStatus,
      },
      "Wise payout executed",
    );

    return {
      reference,
      status: "SENT",
      currency,
      amount: amount.toString(),
      wiseRecipientId: recipientId,
      wiseQuoteId: quoteId,
      wiseTransferId: transferId,
      journalEntryRef: journalRef,
      message: `${amount.toString()} ${currency} sent to ${input.recipient.accountHolderName} via Wise (${wiseStatus})`,
    };
  } catch (error) {
    logger.error(
      { err: error, reference, journalRef },
      "Wise payout failed — reversing ledger entry",
    );
    try {
      await ledgerService.reverseEntry({
        reference: journalRef,
        reason: `Wise payout failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        postedBy: input.postedBy,
      });
    } catch (reverseError) {
      logger.error(
        { err: reverseError, journalRef },
        "CRITICAL: failed to reverse ledger entry after Wise payout failure",
      );
    }
    throw error;
  }
}
