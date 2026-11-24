import { prisma } from "../../core/database.js";
import { Decimal } from "../../core/decimal.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { generateReference } from "../../shared/utils/crypto.js";
import { buildMt103 } from "../swift-mt/mt103.builder.js";

/**
 * SWIFT wire payout — books the ledger movement and emits an MT103.
 *
 * This codebase has no bank/SWIFT transport: it cannot transmit a wire. It
 * records the outflow in the ledger (debit source, credit an external
 * beneficiary account) and produces the MT103 that the operator's bank sends.
 */

export interface SwiftWirePayoutInput {
  amount: string;
  currency?: string;
  /** Ledger account the funds leave, e.g. "PLATFORM:RESERVE:USD". */
  sourceAccountCode: string;
  /** Ledger account created to represent the beneficiary, e.g. "EXTERNAL:PUEE-USD". */
  beneficiaryAccountCode: string;
  beneficiaryName: string;
  beneficiaryAccountNumber?: string;
  beneficiaryAddress?: string[];
  receivingBankName: string;
  receivingBankAddress?: string[];
  receivingBankAccount?: string;
  receivingBankBic?: string;
  intermediaryBic?: string;
  intermediaryName?: string;
  orderingCustomerName: string;
  orderingCustomerAccount?: string;
  reference?: string;
  remittanceInfo?: string;
  chargeBearer?: "OUR" | "SHA" | "BEN";
  /** ISO date (YYYY-MM-DD). Defaults to today. */
  valueDate?: string;
  postedBy: string;
}

export interface SwiftWirePayoutResult {
  reference: string;
  journalEntryRef: string;
  status: "INSTRUCTED";
  amount: string;
  currency: string;
  sourceAccountCode: string;
  beneficiaryAccountCode: string;
  mt103: string;
  message: string;
}

async function ensureExternalAccount(
  code: string,
  name: string,
  currency: string,
): Promise<string> {
  const existing = await prisma.account.findUnique({
    where: { code },
    select: { code: true },
  });
  if (existing) return existing.code;
  await prisma.account.create({
    data: { code, name, type: "LIABILITY", subtype: "EXTERNAL", currency },
  });
  return code;
}

export async function executeSwiftWirePayout(
  input: SwiftWirePayoutInput,
): Promise<SwiftWirePayoutResult> {
  const currency = (input.currency ?? "USD").toUpperCase();
  const amount = new Decimal(input.amount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new ValidationError("Payout amount must be positive");
  }

  const source = await prisma.account.findUnique({
    where: { code: input.sourceAccountCode },
    select: { code: true },
  });
  if (!source) {
    throw new NotFoundError(
      `Source ledger account ${input.sourceAccountCode} was not found`,
    );
  }

  await ensureExternalAccount(
    input.beneficiaryAccountCode,
    `External beneficiary — ${input.beneficiaryName}`,
    currency,
  );

  const reference = generateReference("SWF");
  const journalRef = `JE-${reference}`;
  const valueDate = input.valueDate ?? new Date().toISOString().slice(0, 10);

  // Record the outflow (debit source, credit the external beneficiary account).
  await ledgerService.postEntry({
    reference: journalRef,
    entryType: "PAYOUT",
    description: `SWIFT wire to ${input.beneficiaryName}`,
    source: "SWIFT_WIRE",
    postedBy: input.postedBy,
    metadata: {
      provider: "SWIFT_MT103",
      beneficiary: input.beneficiaryName,
      receivingBank: input.receivingBankName,
      currency,
      amount: amount.toString(),
      externalReference: input.reference ?? null,
      valueDate,
      instructedAt: new Date().toISOString(),
    },
    lines: [
      { accountCode: input.sourceAccountCode, debit: amount.toString(), credit: "0" },
      { accountCode: input.beneficiaryAccountCode, debit: "0", credit: amount.toString() },
    ],
  });

  const mt103 = buildMt103({
    reference: input.reference ?? reference,
    currency,
    amount: amount.toString(),
    valueDate,
    orderingCustomer: {
      name: input.orderingCustomerName,
      account: input.orderingCustomerAccount,
    },
    intermediary:
      input.intermediaryBic || input.intermediaryName
        ? { bic: input.intermediaryBic, name: input.intermediaryName }
        : undefined,
    receivingBank: {
      name: input.receivingBankName,
      account: input.receivingBankAccount,
      address: input.receivingBankAddress,
      bic: input.receivingBankBic,
    },
    beneficiary: {
      name: input.beneficiaryName,
      account: input.beneficiaryAccountNumber,
      address: input.beneficiaryAddress,
    },
    remittanceInfo: input.remittanceInfo,
    chargeBearer: input.chargeBearer,
  });

  logger.info(
    {
      reference,
      journalRef,
      amount: amount.toString(),
      currency,
      source: input.sourceAccountCode,
      beneficiary: input.beneficiaryName,
    },
    "SWIFT wire payout instructed",
  );

  return {
    reference,
    journalEntryRef: journalRef,
    status: "INSTRUCTED",
    amount: amount.toString(),
    currency,
    sourceAccountCode: input.sourceAccountCode,
    beneficiaryAccountCode: input.beneficiaryAccountCode,
    mt103,
    message: `Ledger moved ${amount.toString()} ${currency} from ${input.sourceAccountCode} to ${input.beneficiaryAccountCode}; MT103 generated for ${input.beneficiaryName}. Send the wire via your bank.`,
  };
}
