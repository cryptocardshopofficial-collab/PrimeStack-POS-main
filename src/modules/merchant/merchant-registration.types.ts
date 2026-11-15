import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid date");

const money = z.union([z.string(), z.number()]).transform((value) => String(value));

/**
 * Registration modes. Agent-referred merchants are routed to the reduced
 * subscription tier; direct merchants pay the standard fee. The applicable
 * fee is recorded on the registration for the subscription/payment step.
 */
export const merchantRegistrationModes = ["AGENT_CODE", "DIRECT"] as const;

const merchantFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  contentBase64: z.string().min(1).max(7_000_000),
});

const merchantPhotoSchema = merchantFileSchema.extend({
  contentBase64: z.string().min(1).max(2_800_000),
});

export const registerMerchantPublicSchema = z.object({
  mode: z.enum(merchantRegistrationModes),
  // Required for AGENT_CODE mode; ignored for DIRECT mode. Validated against
  // the agent registry in the service so an unknown code cannot complete.
  agentCode: z.string().trim().max(50).optional(),

  // Company / business details
  legalName: z.string().trim().min(2).max(255),
  dbaName: z.string().trim().max(255).optional(),
  registrationNumber: z.string().trim().min(2).max(100),
  taxId: z.string().trim().max(50).optional(),
  businessType: z.string().trim().min(2).max(100),
  industry: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(100),
  website: z.string().trim().url().max(255).optional(),
  businessAddress: z.string().trim().min(5).max(1000),

  // Primary contact
  contactName: z.string().trim().min(2).max(255),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  phone: z.string().trim().min(5).max(50),

  // AML / compliance declarations
  expectedMonthlyVolume: money,
  expectedMonthlyTransactions: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine((value) => /^\d{1,9}$/.test(value), "Enter a whole number of transactions"),
  sourceOfFunds: z.string().trim().min(3).max(500),
  purposeOfAccount: z.string().trim().min(3).max(500),
  pepDeclaration: z.boolean().default(false),
  sanctionsDeclaration: z
    .boolean()
    .refine((value) => value === true, "The sanctions declaration must be confirmed"),

  // Personal identity (authorised representative)
  fullName: z.string().trim().min(2).max(255),
  dateOfBirth: dateOnly.refine(
    (value) => value < new Date().toISOString().slice(0, 10),
    "Date of birth must be in the past",
  ),
  nationality: z.string().trim().min(2).max(100),
  residentialAddress: z.string().trim().min(5).max(1000),
  governmentIdType: z.enum(["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "OTHER"]),
  governmentIdNumber: z.string().trim().min(2).max(100),
  governmentIdIssuingCountry: z.string().trim().min(2).max(100),
  governmentIdExpiry: dateOnly.optional(),

  // Company documents + personal identity verification
  certificateOfIncorporation: merchantFileSchema,
  tradeLicense: merchantFileSchema,
  directorIdDocument: merchantFileSchema,
  profilePhoto: merchantPhotoSchema,
});

export const validateAgentCodeSchema = z.object({
  agentCode: z.string().trim().min(1).max(50),
});

export type RegisterMerchantPublicInput = z.infer<typeof registerMerchantPublicSchema>;
export type ValidateAgentCodeInput = z.infer<typeof validateAgentCodeSchema>;
