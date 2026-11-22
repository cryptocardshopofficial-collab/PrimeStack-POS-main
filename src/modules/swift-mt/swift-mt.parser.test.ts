import { describe, expect, it } from "vitest";
import { isValidIban, parseSwiftMessage, parseSwiftParty } from "./swift-mt.parser.js";
import { SwiftMtService } from "./swift-mt.service.js";

/**
 * All messages below are synthetic. BICs, names and account numbers are
 * invented — they do not describe any real bank, account or counterparty.
 */

const MT103 = [
  "{1:F01BANKBEBBAXXX0000000000}",
  "{2:I103BANKDEFFXXXXN}",
  "{4:",
  ":20:ABC123",
  ":23B:CRED",
  ":32A:210101USD100000,00",
  ":50K:/12345678",
  "JOHN DOE",
  "123 TEST STREET",
  ":59:/987654321",
  "JANE SMITH",
  "1 TEST AVENUE",
  ":70:INVOICE 4451",
  ":71A:SHA",
  "-}",
].join("\n");

const MT202 = [
  "{1:F01BANKBEBBAXXX0000000000}",
  "{2:I202BANKDEFFXXXXN}",
  "{4:",
  ":20:SETTLE-001",
  ":21:REL-001",
  ":32A:210101EUR5000000,00",
  ":52A:BANKBEBBAXXX",
  ":58A:BANKDEFFXXXX",
  "-}",
].join("\n");

describe("parseSwiftMessage — MT103", () => {
  it("extracts the reference, amount, parties and headers", () => {
    const result = parseSwiftMessage(MT103);

    expect(result.valid).toBe(true);
    expect(result.messageType).toBe("MT103");
    expect(result.parsed?.reference).toBe("ABC123");
    expect(result.parsed?.currency).toBe("USD");
    expect(result.parsed?.amount).toBe("100000.00");
    expect(result.parsed?.valueDate).toBe("2021-01-01");
    expect(result.parsed?.operationCode).toBe("CRED");
    expect(result.parsed?.charges).toBe("SHA");
    expect(result.parsed?.orderingCustomer?.account).toBe("12345678");
    expect(result.parsed?.orderingCustomer?.name).toBe("JOHN DOE");
    expect(result.parsed?.beneficiary?.name).toBe("JANE SMITH");
    expect(result.parsed?.paymentDetails).toBe("INVOICE 4451");
    expect(result.header.senderBic).toBe("BANKBEBBAXXX");
    expect(result.header.receiverBic).toBe("BANKDEFFXXXX");
    expect(result.header.inputOutput).toBe("INPUT");
  });

  it("keeps every block-4 field verbatim", () => {
    const result = parseSwiftMessage(MT103);
    expect(result.parsed?.fields["32A"]).toBe("210101USD100000,00");
    expect(Object.keys(result.parsed?.fields ?? {}).sort()).toEqual([
      "20", "23B", "32A", "50K", "59", "70", "71A",
    ]);
  });

  it("reports missing mandatory fields", () => {
    const withoutCharges = MT103.replace(":71A:SHA\n", "");
    const result = parseSwiftMessage(withoutCharges);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_REQUIRED_FIELD", tag: ":71A:" })]),
    );
  });

  it("rejects an unknown charges code", () => {
    const result = parseSwiftMessage(MT103.replace(":71A:SHA", ":71A:XYZ"));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_CHARGES_CODE" })]),
    );
  });

  it("rejects a malformed :32A: and a zero amount", () => {
    const malformed = parseSwiftMessage(MT103.replace(":32A:210101USD100000,00", ":32A:NOTANAMOUNT"));
    expect(malformed.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_32A" })]),
    );

    const zero = parseSwiftMessage(MT103.replace(":32A:210101USD100000,00", ":32A:210101USD0,00"));
    expect(zero.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ZERO_AMOUNT" })]),
    );
  });
});

describe("parseSwiftMessage — MT202", () => {
  it("parses a bank-to-bank settlement message", () => {
    const result = parseSwiftMessage(MT202);

    expect(result.valid).toBe(true);
    expect(result.messageType).toBe("MT202");
    expect(result.parsed?.reference).toBe("SETTLE-001");
    expect(result.parsed?.relatedReference).toBe("REL-001");
    expect(result.parsed?.currency).toBe("EUR");
    expect(result.parsed?.amount).toBe("5000000.00");
    expect(result.parsed?.orderingInstitution?.bic).toBe("BANKBEBBAXXX");
    expect(result.parsed?.beneficiaryInstitution?.bic).toBe("BANKDEFFXXXX");
    expect(result.parsed?.operationCode).toBeNull();
  });

  it("requires the related reference :21:", () => {
    const result = parseSwiftMessage(MT202.replace(":21:REL-001\n", ""));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: ":21:" })]),
    );
  });
});

describe("parseSwiftMessage — message type detection", () => {
  it("accepts a bare block-4 payload and infers MT103", () => {
    const result = parseSwiftMessage(":20:REF1\n:23B:CRED\n:32A:210101USD10,00\n:50K:/1\nACME\n:59:/2\nBETA\n:71A:BEN");
    expect(result.messageType).toBe("MT103");
    expect(result.valid).toBe(true);
  });

  it("honours an explicit messageType override", () => {
    const result = parseSwiftMessage(":20:REF1\n:21:REL\n:32A:210101USD10,00\n:58A:BANKDEFFXXXX", {
      messageType: "MT202",
    });
    expect(result.messageType).toBe("MT202");
    expect(result.valid).toBe(true);
  });

  it("fails when neither block 2 nor the field set identifies the type", () => {
    const result = parseSwiftMessage(":32A:210101USD10,00");
    expect(result.messageType).toBeNull();
    expect(result.parsed).toBeNull();
    expect(result.errors[0].code).toBe("MISSING_MESSAGE_TYPE");
  });
});

describe("parseSwiftParty", () => {
  it("reads option A structured elements", () => {
    const party = parseSwiftParty("/DE89370400440532013000\nBANKDEFFXXXX\n1/ACME GMBH\n2/TESTSTRASSE 1");
    expect(party.account).toBe("DE89370400440532013000");
    expect(party.bic).toBe("BANKDEFFXXXX");
    expect(party.name).toBe("ACME GMBH");
    expect(party.address).toEqual(["TESTSTRASSE 1"]);
  });

  it("reads free-form option K lines", () => {
    const party = parseSwiftParty("/12345\nJOHN DOE\n1 MAIN ST\nTOWN");
    expect(party.account).toBe("12345");
    expect(party.name).toBe("JOHN DOE");
    expect(party.address).toEqual(["1 MAIN ST", "TOWN"]);
  });
});

describe("isValidIban", () => {
  it("accepts a checksum-valid IBAN", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
  });

  it("rejects a corrupted IBAN", () => {
    expect(isValidIban("DE89370400440532013001")).toBe(false);
  });

  it("ignores non-IBAN account numbers", () => {
    expect(isValidIban("12345678")).toBe(false);
  });
});

describe("SwiftMtService", () => {
  it("builds a hub-shaped MT103 payment", () => {
    const service = new SwiftMtService();
    const outcome = service.parse(MT103);

    expect(outcome.payment?.rail).toBe("SWIFT_MT103");
    expect(outcome.payment?.reference).toBe("ABC123");
    expect(outcome.payment?.amount).toBe("100000.00");
    expect(outcome.payment?.debtor?.name).toBe("JOHN DOE");
    expect(outcome.payment?.creditor?.name).toBe("JANE SMITH");
    expect(outcome.payment?.charges).toBe("SHA");
  });

  it("maps MT202 institutions to debtor and creditor", () => {
    const service = new SwiftMtService();
    const outcome = service.parse(MT202);

    expect(outcome.payment?.rail).toBe("SWIFT_MT202");
    expect(outcome.payment?.debtor?.bic).toBe("BANKBEBBAXXX");
    expect(outcome.payment?.debtor?.country).toBe("BE");
    expect(outcome.payment?.creditor?.bic).toBe("BANKDEFFXXXX");
    expect(outcome.payment?.creditor?.country).toBe("DE");
  });

  it("rejects an empty message", () => {
    const service = new SwiftMtService();
    const outcome = service.parse("   ");
    expect(outcome.valid).toBe(false);
    expect(outcome.errors[0].code).toBe("EMPTY_MESSAGE");
    expect(outcome.payment).toBeNull();
  });

  it("lists the supported message types", () => {
    const service = new SwiftMtService();
    expect(service.describeTypes().map((entry) => entry.messageType)).toEqual(["MT103", "MT202"]);
  });
});
