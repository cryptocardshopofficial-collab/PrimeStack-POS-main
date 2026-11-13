import { describe, expect, it } from "vitest";
import { registerAgentKycSchema } from "./agent-registration.types.js";
import {
  decodeAgentKycFiles,
  decryptAgentKycValue,
  encryptAgentKycValue,
  generateAgentLoginPin,
} from "./agent-kyc-vault.js";

const pdf = Buffer.from("%PDF-1.7\nagent id");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function registrationInput() {
  return registerAgentKycSchema.parse({
    fullName: "Example Agent",
    email: "agent@example.com",
    mobileNumber: "+1 555 0100",
    residentialAddress: "10 Example Street",
    dateOfBirth: "1990-01-01",
    nationality: "Example",
    country: "Example",
    governmentIdType: "PASSPORT",
    governmentIdNumber: "EXAMPLE-1234",
    governmentIdIssuingCountry: "Example",
    idDocument: {
      fileName: "../../passport.pdf",
      mimeType: "application/pdf",
      contentBase64: pdf.toString("base64"),
    },
    profilePhoto: {
      fileName: "profile.png",
      mimeType: "image/png",
      contentBase64: png.toString("base64"),
    },
  });
}

describe("agent KYC vault", () => {
  it("encrypts values and rejects modified ciphertext", () => {
    const envelope = encryptAgentKycValue("private KYC data");
    const [version, iv, tag, ciphertext] = envelope.split(".");
    const changedTag = (tag[0] === "A" ? "B" : "A") + tag.slice(1);

    expect(envelope).not.toContain("private KYC data");
    expect(decryptAgentKycValue(envelope).toString("utf8")).toBe("private KYC data");
    expect(() =>
      decryptAgentKycValue([version, iv, changedTag, ciphertext].join(".")),
    ).toThrow();
  });

  it("checks uploaded file signatures and strips directory names", () => {
    const files = decodeAgentKycFiles(registrationInput());

    expect(files.identityDocument.fileName).toBe("passport.pdf");
    expect(files.identityDocument.bytes).toEqual(pdf);
    expect(files.profilePhoto.mimeType).toBe("image/png");

    const spoofed = registrationInput();
    expect(() =>
      decodeAgentKycFiles({
        ...spoofed,
        idDocument: {
          ...spoofed.idDocument,
          contentBase64: Buffer.from("not a PDF").toString("base64"),
        },
      }),
    ).toThrow("KYC file type does not match the file contents");
  });

  it("generates twelve-digit PINs", () => {
    const pins = Array.from({ length: 100 }, generateAgentLoginPin);

    expect(pins.every((pin) => /^\d{12}$/.test(pin))).toBe(true);
    expect(new Set(pins).size).toBe(pins.length);
  });
});
