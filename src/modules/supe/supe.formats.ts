import type { SupeParty, SupeSettlementFormat } from "./types.js";

/**
 * SUPE format adapters — pure functions that render a settlement instruction
 * into a payload the destination bank accepts. No I/O, no side effects, so
 * they are trivial to unit-test.
 */

/** The fully-resolved data needed to render any format. Built by the service. */
export interface InstructionRenderInput {
  reference: string;
  messageId: string;
  paymentInfoId: string;
  endToEndId: string;
  uetr: string;
  createdAt: string; // ISO 8601
  valueDate: string | null; // YYYY-MM-DD or null
  amount: string; // canonical decimal string
  currency: string;
  debtor: SupeParty;
  creditor: SupeParty;
  remittanceInformation: string | null;
}

/** RFC 4180 CSV field escaping. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    const map: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return map[c] ?? c;
  });
}

function xmlEl(name: string, value: string | undefined | null): string {
  return value ? `<${name}>${xmlEscape(value)}</${name}>` : "";
}

function postalAddress(party: SupeParty): string {
  return (
    "<PstlAdr>" +
    xmlEl("StrtNm", party.streetName) +
    xmlEl("BldgNb", party.buildingNumber) +
    xmlEl("PstCd", party.postalCode) +
    xmlEl("TwnNm", party.townName) +
    xmlEl("Ctry", party.country) +
    "</PstlAdr>"
  );
}

function agent(party: SupeParty): string {
  return `<FinInstnId>${xmlEl("BICFI", party.agentBic)}${xmlEl("Nm", party.agentName)}</FinInstnId>`;
}

/** ISO 20022 pain.001.001.03 — Customer Credit Transfer Initiation. */
export function renderPain001(d: InstructionRenderInput): string {
  const debtorName = xmlEl("Nm", d.debtor.name);
  const creditorName = xmlEl("Nm", d.creditor.name);
  const valueDate = d.valueDate ? `<ReqdExctnDt>${d.valueDate}</ReqdExctnDt>` : "";
  const remittance = d.remittanceInformation
    ? `<RmtInf><Ustrd>${xmlEscape(d.remittanceInformation)}</Ustrd></RmtInf>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEscape(d.messageId)}</MsgId>
      <CreDtTm>${d.createdAt}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${d.amount}</CtrlSum>
      <InitgPty>${debtorName}</InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEscape(d.paymentInfoId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${d.amount}</CtrlSum>
      ${valueDate}
      <Dbtr>${debtorName}${postalAddress(d.debtor)}</Dbtr>
      <DbtrAcct><Id><IBAN>${xmlEscape(d.debtor.iban)}</IBAN></Id></DbtrAcct>
      <DbtrAgt>${agent(d.debtor)}</DbtrAgt>
      <ChrgBr>SHAR</ChrgBr>
      <CdtTrfTxInf>
        <PmtId>
          <InstrId>${xmlEscape(d.messageId)}</InstrId>
          <EndToEndId>${xmlEscape(d.endToEndId)}</EndToEndId>
          <UETR>${xmlEscape(d.uetr)}</UETR>
        </PmtId>
        <Amt><InstdAmt Ccy="${d.currency}">${d.amount}</InstdAmt></Amt>
        <CdtrAgt>${agent(d.creditor)}</CdtrAgt>
        <Cdtr>${creditorName}${postalAddress(d.creditor)}</Cdtr>
        <CdtrAcct><Id><IBAN>${xmlEscape(d.creditor.iban)}</IBAN></Id></CdtrAcct>
        ${remittance}
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
}

/** Generic bank flat-file CSV. */
export function renderCsv(d: InstructionRenderInput): string {
  const header = [
    "reference",
    "value_date",
    "debtor_name",
    "debtor_iban",
    "debtor_bic",
    "creditor_name",
    "creditor_iban",
    "creditor_bic",
    "amount",
    "currency",
    "end_to_end_id",
    "remittance",
  ].join(",");

  const row = [
    d.reference,
    d.valueDate ?? "",
    d.debtor.name,
    d.debtor.iban,
    d.debtor.agentBic,
    d.creditor.name,
    d.creditor.iban,
    d.creditor.agentBic,
    d.amount,
    d.currency,
    d.endToEndId,
    d.remittanceInformation ?? "",
  ]
    .map(csvField)
    .join(",");

  return `${header}\r\n${row}\r\n`;
}

/** Structured JSON payload. */
export function renderJson(d: InstructionRenderInput): string {
  return JSON.stringify(
    {
      reference: d.reference,
      messageId: d.messageId,
      endToEndId: d.endToEndId,
      uetr: d.uetr,
      createdAt: d.createdAt,
      valueDate: d.valueDate,
      amount: d.amount,
      currency: d.currency,
      debtor: {
        name: d.debtor.name,
        iban: d.debtor.iban,
        bic: d.debtor.agentBic,
        bankName: d.debtor.agentName ?? null,
        country: d.debtor.country,
      },
      creditor: {
        name: d.creditor.name,
        iban: d.creditor.iban,
        bic: d.creditor.agentBic,
        bankName: d.creditor.agentName ?? null,
        country: d.creditor.country,
      },
      remittanceInformation: d.remittanceInformation ?? null,
    },
    null,
    2,
  );
}

/** MIME type for each format, used on the download endpoint. */
export function formatMime(format: SupeSettlementFormat): string {
  switch (format) {
    case "ISO_20022":
      return "application/xml";
    case "CSV":
      return "text/csv";
    case "JSON":
      return "application/json";
  }
}

/** File extension for each format. */
export function formatExtension(format: SupeSettlementFormat): string {
  switch (format) {
    case "ISO_20022":
      return "xml";
    case "CSV":
      return "csv";
    case "JSON":
      return "json";
  }
}

/** Render the instruction payload in the requested format. */
export function renderInstructionPayload(
  format: SupeSettlementFormat,
  d: InstructionRenderInput,
): string {
  switch (format) {
    case "ISO_20022":
      return renderPain001(d);
    case "CSV":
      return renderCsv(d);
    case "JSON":
      return renderJson(d);
  }
}

// ── Inbound: ISO 20022 pacs.002 status report parsing ───────────
// A bank reports the validation/execution outcome of an instruction as a
// pacs.002 (FIToFIPmtStsRpt). This maps the bank's TxSts code to the SUPE
// instruction lifecycle.

export interface ParsedPacs002 {
  orgnlEndToEndId: string | null;
  orgnlInstrId: string | null;
  txSts: string | null;
  /** Bank-side execution reference (AcctSvcrRef). */
  acctSvcrRef: string | null;
  reason: string | null;
  /** Mapped SUPE lifecycle status. */
  status: "ACCEPTED" | "REJECTED" | "EXECUTED" | null;
  bankTransactionRef: string | null;
  rejectionReason: string | null;
}

/** Extract the first <TxInf> block from a pacs.002 report. */
export function parsePacs002StatusReport(xml: string): ParsedPacs002 {
  const txInf = xml.match(/<TxInf>([\s\S]*?)<\/TxInf>/);
  if (!txInf) {
    return {
      orgnlEndToEndId: null,
      orgnlInstrId: null,
      txSts: null,
      acctSvcrRef: null,
      reason: null,
      status: null,
      bankTransactionRef: null,
      rejectionReason: null,
    };
  }
  const block = txInf[1];

  const orgnlEndToEndId = block.match(/<OrgnlEndToEndId>([\s\S]*?)<\/OrgnlEndToEndId>/)?.[1].trim() ?? null;
  const orgnlInstrId = block.match(/<OrgnlInstrId>([\s\S]*?)<\/OrgnlInstrId>/)?.[1].trim() ?? null;
  const txSts = block.match(/<TxSts>([\s\S]*?)<\/TxSts>/)?.[1].trim() ?? null;
  const acctSvcrRef = block.match(/<AcctSvcrRef>([\s\S]*?)<\/AcctSvcrRef>/)?.[1].trim() ?? null;
  const reasonCode = block.match(/<Rsn>[\s\S]*?<Cd>([\s\S]*?)<\/Cd>/)?.[1].trim() ?? null;
  const reasonAddtl = block.match(/<AddtlInf>([\s\S]*?)<\/AddtlInf>/)?.[1].trim() ?? null;
  const reason = reasonCode || reasonAddtl || null;

  // ISO 20022 external status codes (TxSts):
  //   ACSC — Accepted Settlement Completed → EXECUTED
  //   ACSP / ACTC — Accepted (in processing / technical validation) → ACCEPTED
  //   RJCT — Rejected → REJECTED
  //   PEND / ACWC — pending / accepted with change → left as ACCEPTED (awaiting)
  let status: ParsedPacs002["status"] = null;
  let bankTransactionRef: string | null = null;
  let rejectionReason: string | null = null;
  switch (txSts) {
    case "ACSC":
      status = "EXECUTED";
      bankTransactionRef = acctSvcrRef;
      break;
    case "ACSP":
    case "ACTC":
    case "ACWC":
    case "PEND":
      status = "ACCEPTED";
      break;
    case "RJCT":
      status = "REJECTED";
      rejectionReason = reason;
      break;
    default:
      status = null;
  }

  return { orgnlEndToEndId, orgnlInstrId, txSts, acctSvcrRef, reason, status, bankTransactionRef, rejectionReason };
}


// ── Inbound bank-feed parsing ────────────────────
// A bank feed delivers several ISO 20022 messages. Only a CONFIRMATION
// (camt.054 credit notification, or pacs.002 ACSC) finalises a ledger
// credit; an initiation (pacs.008 / pain.001) is recorded as PENDING.

export type Iso20022MessageType =
  | "pacs.008"
  | "pacs.002"
  | "camt.054"
  | "pain.001"
  | "ISO_20022";

export function detectIso20022MessageType(xml: string): Iso20022MessageType {
  if (xml.includes("pacs.008") || xml.includes("FIToFICstmrCdtTrf")) return "pacs.008";
  if (xml.includes("pacs.002") || xml.includes("FIToFIPmtStsRpt")) return "pacs.002";
  if (xml.includes("camt.054") || xml.includes("BkToCstmrDbtCdtNtfctn")) return "camt.054";
  if (xml.includes("pain.001") || xml.includes("CstmrCdtTrfInitn")) return "pain.001";
  return "ISO_20022";
}

function normalizeAmount(value: string): string {
  return value.replace(/\s+/g, "").replace(",", ".");
}

export interface ParsedInitiation {
  endToEndId: string | null;
  amount: string | null;
  currency: string | null;
  sender: string | null;
  valueDate: string | null;
}

/** Parse an initiation message (pacs.008 / pain.001) into a pending expectation. */
export function parseInitiationMessage(xml: string): ParsedInitiation {
  const amtMatch =
    xml.match(/<InstdAmt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.,]+)<\/InstdAmt>/) ||
    xml.match(/<IntrBkSttlmAmt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.,]+)<\/IntrBkSttlmAmt>/) ||
    xml.match(/<Amt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.,]+)<\/Amt>/);
  const currency = amtMatch?.[1] ?? null;
  const amount = amtMatch ? normalizeAmount(amtMatch[2]) : null;

  const refMatch =
    xml.match(/<EndToEndId>([\s\S]*?)<\/EndToEndId>/) ||
    xml.match(/<InstrId>([\s\S]*?)<\/InstrId>/) ||
    xml.match(/<MsgId>([\s\S]*?)<\/MsgId>/);
  const endToEndId = refMatch?.[1].trim() ?? null;

  const senderMatch =
    xml.match(/<Dbtr>[\s\S]*?<Nm>([\s\S]*?)<\/Nm>/) ||
    xml.match(/<InitgPty>[\s\S]*?<Nm>([\s\S]*?)<\/Nm>/);
  const sender = senderMatch?.[1].trim() ?? null;

  const dateMatch =
    xml.match(/<IntrBkSttlmDt>([\s\S]*?)<\/IntrBkSttlmDt>/) ||
    xml.match(/<ReqdExctnDt>([\s\S]*?)<\/ReqdExctnDt>/) ||
    xml.match(/<CreDtTm>([\s\S]*?)<\/CreDtTm>/);
  const valueDate = dateMatch?.[1].trim().split("T")[0] ?? null;

  return { endToEndId, amount, currency, sender, valueDate };
}

export interface ParsedCamt054 {
  endToEndId: string | null;
  amount: string | null;
  currency: string | null;
  sender: string | null;
  valueDate: string | null;
  /** true when the bank reports a credit (CdtDbtInd = CRDT). */
  isCredit: boolean;
}

/** Parse a camt.054 bank-to-customer credit notification. */
export function parseCamt054CreditNotification(xml: string): ParsedCamt054 {
  const txDtls = xml.match(/<TxDtls>([\s\S]*?)<\/TxDtls>/);
  const block = txDtls ? txDtls[1] : xml;

  const endToEndId = block.match(/<EndToEndId>([\s\S]*?)<\/EndToEndId>/)?.[1].trim() ?? null;

  const amtMatch =
    block.match(/<Amt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.,]+)<\/Amt>/) ||
    xml.match(/<Amt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.,]+)<\/Amt>/);
  const currency = amtMatch?.[1] ?? null;
  const amount = amtMatch ? normalizeAmount(amtMatch[2]) : null;

  const senderMatch = block.match(/<Dbtr>[\s\S]*?<Nm>([\s\S]*?)<\/Nm>/);
  const sender = senderMatch?.[1].trim() ?? null;

  const valMatch = block.match(/<ValDt>[\s\S]*?<Dt>([\s\S]*?)<\/Dt>/) || xml.match(/<BookgDt>[\s\S]*?<Dt>([\s\S]*?)<\/Dt>/);
  const valueDate = valMatch?.[1].trim().split("T")[0] ?? null;

  const cdtDbtInd = (block.match(/<CdtDbtInd>([\s\S]*?)<\/CdtDbtInd>/)?.[1].trim() ?? "").toUpperCase();
  const isCredit = cdtDbtInd === "" ? true : cdtDbtInd === "CRDT";

  return { endToEndId, amount, currency, sender, valueDate, isCredit };
}
