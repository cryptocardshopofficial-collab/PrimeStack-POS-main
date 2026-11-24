/**
 * SWIFT MT103 (Single Customer Credit Transfer) builder.
 *
 * Produces the payment-detail fields (block 4) a bank needs to originate a
 * cross-border wire. The platform is not a bank, so block 1/2 carry the
 * ordering/receiving BICs when supplied and fall back to placeholders for the
 * sending bank to complete.
 */

export interface Mt103Party {
  name: string;
  account?: string;
  /** Free-form address lines (up to 4 are emitted). */
  address?: string[];
  /** 8- or 11-character BIC. */
  bic?: string;
}

export interface Mt103Intermediary {
  bic?: string;
  name?: string;
  account?: string;
}

export interface Mt103Input {
  reference: string;
  currency: string;
  /** Decimal string, e.g. "50000.00". */
  amount: string;
  /** ISO date (YYYY-MM-DD) or SWIFT date (YYMMDD). */
  valueDate: string;
  orderingCustomer: Mt103Party;
  intermediary?: Mt103Intermediary;
  receivingBank: Mt103Party;
  beneficiary: Mt103Party;
  remittanceInfo?: string;
  chargeBearer?: "OUR" | "SHA" | "BEN";
  senderBic?: string;
  receiverBic?: string;
}

function only(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => Boolean(line && line.length > 0)).join("\n");
}

function swiftDate(value: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (iso) return `${iso[1].slice(2)}${iso[2]}${iso[3]}`;
  return value.replace(/\D/g, "").slice(-6);
}

function swiftAmount(amount: string): string {
  const [whole, fraction = ""] = amount.trim().split(".");
  return `${whole},${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function addressBlock(lines: string[] | undefined): string {
  return (lines ?? [])
    .slice(0, 4)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function bic12(bic: string | undefined): string {
  return bic ? `${bic.toUpperCase()}XXXX`.slice(0, 12) : "XXXXXXXXXXXX";
}

function partyBlock(party: Mt103Party): string {
  return only([
    party.account ? `/${party.account.trim()}` : undefined,
    party.name.trim(),
    addressBlock(party.address),
  ]);
}

export function buildMt103(input: Mt103Input): string {
  const header = `{1:F01${bic12(input.senderBic)}}{2:I103${bic12(input.receiverBic)}}`;

  const intermediaryLine = input.intermediary?.bic
    ? `:56A:${input.intermediary.bic.toUpperCase()}`
    : input.intermediary && (input.intermediary.name || input.intermediary.account)
      ? `:56D:${only([
          input.intermediary.account ? `/${input.intermediary.account.trim()}` : undefined,
          input.intermediary.name,
        ])}`
      : undefined;

  const receivingLine = input.receivingBank.bic
    ? `:57A:${input.receivingBank.bic.toUpperCase()}`
    : `:57D:${partyBlock(input.receivingBank)}`;

  const body = only([
    `:20:${input.reference}`,
    ":23B:CRED",
    `:32A:${swiftDate(input.valueDate)}${input.currency.toUpperCase()}${swiftAmount(input.amount)}`,
    `:50K:${partyBlock(input.orderingCustomer)}`,
    intermediaryLine,
    receivingLine,
    `:59:${partyBlock(input.beneficiary)}`,
    input.remittanceInfo ? `:70:${input.remittanceInfo.trim()}` : undefined,
    `:71A:${input.chargeBearer ?? "SHA"}`,
  ]);

  return `${header}\n{4:\n${body}\n-}`;
}
