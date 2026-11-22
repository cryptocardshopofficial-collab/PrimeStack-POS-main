import type {
  ParsedSwiftMessage,
  SwiftFieldMap,
  SwiftMessageType,
  SwiftParseResult,
  SwiftParty,
  SwiftValidationIssue,
} from "./swift-mt.types.js";

/**
 * SWIFT MT103 / MT202 parser.
 *
 * Handles the on-the-wire block structure:
 *
 *   {1:F01BANKBEBBAXXX0000000000}
 *   {2:I103BANKDEFFXXXXN}
 *   {4:
 *   :20:REFERENCE
 *   :23B:CRED
 *   :32A:210101USD100000,00
 *   :50K:/12345678
 *   ORDERING CUSTOMER
 *   :59:/987654321
 *   BENEFICIARY NAME
 *   :71A:SHA
 *   -}
 *
 * A bare block-4 payload (no `{4:` wrapper) is also accepted, which is what
 * most SDK samples and operator pastes look like.
 */

const FIELD_LINE = /^:([0-9]{2}[A-Z]?):(.*)$/;
// Accepts an 8/11-character BIC as well as the 12-character LT address form
// (BIC + branch + location) that option A party fields carry on the wire.
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3}[A-Z0-9]?)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AMOUNT_PATTERN = /^(\d{1,13})(?:,(\d{0,2}))?$/;
const STRUCTURED_LINE = /^\d\//;

/** Required tags per message type; a value is a single tag or a list of alternatives. */
const REQUIRED_FIELDS: Record<SwiftMessageType, string[][]> = {
  MT103: [["20"], ["23B"], ["32A"], ["50K", "50A", "50F"], ["59", "59A"], ["71A"]],
  MT202: [["20"], ["21"], ["32A"], ["58A", "58D"]],
};

function issue(tag: string, code: string, message: string): SwiftValidationIssue {
  return { tag, code, message };
}

interface HeaderInfo {
  senderBic: string | null;
  receiverBic: string | null;
  inputOutput: "INPUT" | "OUTPUT" | null;
  declaredType: SwiftMessageType | null;
}

function extractHeader(raw: string): HeaderInfo {
  const block1 = /\{1:([A-Z0-9]+)\}/.exec(raw);
  const block2 = /\{2:([IO])(\d{3})([A-Z0-9]{12})/.exec(raw);

  const senderBic = block1 ? block1[1].slice(3, 15) || null : null;
  const receiverBic = block2 ? block2[3] : null;
  const inputOutput = block2 ? (block2[1] === "I" ? "INPUT" : "OUTPUT") : null;

  let declaredType: SwiftMessageType | null = null;
  if (block2) {
    const candidate = `MT${block2[2]}`;
    if (candidate === "MT103" || candidate === "MT202") declaredType = candidate;
  }

  return { senderBic, receiverBic, inputOutput, declaredType };
}

function extractBlock4(raw: string): string {
  const start = raw.indexOf("{4:");
  let body = start >= 0 ? raw.slice(start + 3) : raw;
  const end = body.lastIndexOf("-}");
  if (end >= 0) {
    body = body.slice(0, end);
  } else {
    const brace = body.lastIndexOf("}");
    if (brace >= 0) body = body.slice(0, brace);
  }
  return body.replace(/^[\r\n]+/, "");
}

function parseFields(block4: string): Array<{ tag: string; value: string }> {
  const fields: Array<{ tag: string; value: string }> = [];
  let current: { tag: string; value: string } | null = null;

  for (const rawLine of block4.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = FIELD_LINE.exec(line.trim());
    if (match) {
      if (current) fields.push(current);
      current = { tag: match[1], value: match[2] };
    } else if (current && line.trim() !== "") {
      current.value += `\n${line}`;
    }
  }
  if (current) fields.push(current);
  return fields;
}

/**
 * Split a party field into account / BIC / name / address.
 * Handles both option K (`/account` then free-form name+address) and option A
 * (`/account`, BIC, then `1/NAME`, `2/ADDRESS` structured elements).
 */
export function parseSwiftParty(value: string): SwiftParty {
  const lines = value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const party: SwiftParty = { account: null, bic: null, name: null, address: [], raw: value };

  for (const line of lines) {
    if (line.startsWith("/")) {
      const account = line.replace(/^\/+/, "").trim();
      if (account !== "") party.account = account;
      continue;
    }
    const structured = STRUCTURED_LINE.exec(line);
    if (structured) {
      const element = line.replace(STRUCTURED_LINE, "").trim();
      if (party.name === null) party.name = element;
      else party.address.push(element);
      continue;
    }
    const bare = line.trim();
    if (party.bic === null && BIC_PATTERN.test(bare)) {
      party.bic = bare;
      continue;
    }
    if (party.name === null) party.name = bare;
    else party.address.push(bare);
  }

  return party;
}

function normalizeAmount(raw: string): string | null {
  const match = AMOUNT_PATTERN.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function normalizeDate(yymmdd: string): string | null {
  const year = Number.parseInt(yymmdd.slice(0, 2), 10);
  const month = Number.parseInt(yymmdd.slice(2, 4), 10);
  const day = Number.parseInt(yymmdd.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const fullYear = year >= 70 ? 1900 + year : 2000 + year;
  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function detectMessageType(
  header: HeaderInfo,
  fields: SwiftFieldMap,
): SwiftMessageType | null {
  if (header.declaredType) return header.declaredType;

  const has = (...tags: string[]) => tags.some((tag) => fields[tag] !== undefined);

  // A customer transfer carries an operation code; MT202 does not.
  if (has("23B", "50K", "50A", "50F", "71A")) return "MT103";
  if (has("21", "58A", "58D")) return "MT202";
  return null;
}

/** Parse a raw MT103/MT202 message and validate it. */
export function parseSwiftMessage(
  raw: string,
  options: { messageType?: SwiftMessageType } = {},
): SwiftParseResult {
  const errors: SwiftValidationIssue[] = [];
  const warnings: SwiftValidationIssue[] = [];
  const header = extractHeader(raw);
  const fieldsList = parseFields(extractBlock4(raw));

  const fields: SwiftFieldMap = {};
  for (const field of fieldsList) fields[field.tag] = field.value;

  const messageType = options.messageType ?? detectMessageType(header, fields);

  if (!messageType) {
    errors.push(
      issue(":2:", "MISSING_MESSAGE_TYPE", "Could not determine message type — supply messageType or a valid block 2"),
    );
    return {
      messageType: null,
      parsed: null,
      valid: false,
      errors,
      warnings,
      header: {
        senderBic: header.senderBic,
        receiverBic: header.receiverBic,
        inputOutput: header.inputOutput,
      },
    };
  }

  const parsed = buildMessage(messageType, fields, header, errors, warnings);
  return {
    messageType,
    parsed,
    valid: errors.length === 0,
    errors,
    warnings,
    header: {
      senderBic: header.senderBic,
      receiverBic: header.receiverBic,
      inputOutput: header.inputOutput,
    },
  };
}

function buildMessage(
  messageType: SwiftMessageType,
  fields: SwiftFieldMap,
  header: HeaderInfo,
  errors: SwiftValidationIssue[],
  warnings: SwiftValidationIssue[],
): ParsedSwiftMessage {
  // ── :32A: value date / currency / amount ─────────
  let valueDate: string | null = null;
  let currency: string | null = null;
  let amount: string | null = null;

  const raw32A = fields["32A"];
  if (raw32A !== undefined) {
    const match = /^(\d{6})([A-Za-z]{3})([\d,]+)$/.exec(raw32A.trim());
    if (!match) {
      errors.push(issue(":32A:", "MALFORMED_32A", "32A must be YYMMDD + currency + amount, e.g. 210101USD100000,00"));
    } else {
      valueDate = normalizeDate(match[1]);
      currency = match[2].toUpperCase();
      amount = normalizeAmount(match[3]);
      if (valueDate === null) {
        errors.push(issue(":32A:", "INVALID_VALUE_DATE", `Invalid value date: ${match[1]}`));
      }
      if (amount === null) {
        errors.push(issue(":32A:", "INVALID_AMOUNT", `Invalid amount: ${match[3]}`));
      } else if (amount === "0.00") {
        errors.push(issue(":32A:", "ZERO_AMOUNT", "Amount must be greater than zero"));
      }
    }
  }

  // ── :71A: charges ────────────────────────────────
  const charges = fields["71A"]?.trim() ?? null;

  const message: ParsedSwiftMessage = {
    messageType,
    reference: fields["20"]?.trim() ?? null,
    operationCode: messageType === "MT103" ? fields["23B"]?.trim() ?? null : null,
    relatedReference: messageType === "MT202" ? fields["21"]?.trim() ?? null : null,
    valueDate,
    currency,
    amount,
    orderingCustomer: pick(fields, "50K", "50A", "50F"),
    beneficiary: pick(fields, "59", "59A"),
    orderingInstitution: pick(fields, "52A", "52D"),
    beneficiaryInstitution: pick(fields, "58A", "58D"),
    paymentDetails: fields["70"]?.trim() ?? null,
    charges,
    senderToReceiverInfo: fields["72"]?.trim() ?? null,
    senderBic: header.senderBic,
    receiverBic: header.receiverBic,
    fields,
  };

  validateMessage(message, errors, warnings);
  return message;
}

function pick(fields: SwiftFieldMap, ...tags: string[]): SwiftParty | null {
  for (const tag of tags) {
    const value = fields[tag];
    if (value !== undefined && value.trim() !== "") return parseSwiftParty(value);
  }
  return null;
}

/** Structural validation: required fields, code formats, identifier checks. */
export function validateMessage(
  message: ParsedSwiftMessage,
  errors: SwiftValidationIssue[] = [],
  warnings: SwiftValidationIssue[] = [],
): { errors: SwiftValidationIssue[]; warnings: SwiftValidationIssue[] } {
  const required = REQUIRED_FIELDS[message.messageType];
  for (const alternatives of required) {
    const present = alternatives.some((tag) => message.fields[tag] !== undefined);
    if (!present) {
      errors.push(
        issue(
          `:${alternatives[0]}:`,
          "MISSING_REQUIRED_FIELD",
          `${message.messageType} requires ${alternatives.map((tag) => `:${tag}:`).join(" or ")}`,
        ),
      );
    }
  }

  if (message.operationCode !== null && !/^[A-Z]{4}$/.test(message.operationCode)) {
    errors.push(issue(":23B:", "INVALID_OPERATION_CODE", `Operation code must be 4 letters, got "${message.operationCode}"`));
  }

  if (message.charges !== null && !["BEN", "OUR", "SHA"].includes(message.charges)) {
    errors.push(issue(":71A:", "INVALID_CHARGES_CODE", `Charges must be BEN, OUR or SHA, got "${message.charges}"`));
  }

  if (message.currency !== null && !CURRENCY_PATTERN.test(message.currency)) {
    errors.push(issue(":32A:", "INVALID_CURRENCY", `Currency must be a 3-letter ISO code, got "${message.currency}"`));
  }

  for (const [tag, party] of partyFields(message)) {
    if (party?.bic && !BIC_PATTERN.test(party.bic)) {
      warnings.push(issue(`:${tag}:`, "SUSPECT_BIC", `"${party.bic}" does not look like a valid BIC`));
    }
    if (party?.account && isIbanLike(party.account) && !isValidIban(party.account)) {
      warnings.push(issue(`:${tag}:`, "SUSPECT_IBAN", `"${party.account}" fails the IBAN checksum`));
    }
  }

  return { errors, warnings };
}

function partyFields(message: ParsedSwiftMessage): Array<[string, SwiftParty | null]> {
  return [
    ["50K", message.orderingCustomer],
    ["59", message.beneficiary],
    ["52A", message.orderingInstitution],
    ["58A", message.beneficiaryInstitution],
  ];
}

function isIbanLike(value: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value.replace(/\s+/g, "").toUpperCase());
}

/** ISO 13616 mod-97 checksum. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!isIbanLike(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (char) => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
