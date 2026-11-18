import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid date");

const agentFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  contentBase64: z.string().min(1).max(7_000_000),
});

const profilePhotoSchema = agentFileSchema.extend({
  contentBase64: z.string().min(1).max(2_800_000),
});

export const registerAgentKycSchema = z.object({
  fullName: z.string().trim().min(2).max(255),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  mobileNumber: z.string().trim().min(5).max(50),
  residentialAddress: z.string().trim().min(5).max(1000),
  dateOfBirth: dateOnly.refine((value) => value < new Date().toISOString().slice(0, 10), "Date of birth must be in the past"),
  nationality: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(100),
  governmentIdType: z.enum(["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "OTHER"]),
  governmentIdNumber: z.string().trim().min(2).max(100),
  governmentIdIssuingCountry: z.string().trim().min(2).max(100),
  governmentIdExpiry: dateOnly.optional(),
  idDocument: agentFileSchema,
  profilePhoto: profilePhotoSchema,
});

export const updateAgentKycStatusSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  reviewNotes: z.string().trim().max(1000).optional(),
});

export const agentPortalLoginSchema = z.object({
  code: z.string().trim().min(1).max(50),
  pin: z.string().regex(/^\d{12}$/, "Enter the 12-digit Agent Login PIN"),
});

export const agentTransactionControlReasonSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const agentTransactionControlResponseSchema = z.object({
  response: z.string().trim().min(3).max(1000),
});

export const reviewAgentTransactionControlSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFO"]),
  adminRemarks: z.string().trim().min(3).max(1000),
});

export type RegisterAgentKycInput = z.infer<typeof registerAgentKycSchema>;
export type AgentKycStatusInput = z.infer<typeof updateAgentKycStatusSchema>;
export type AgentPortalLoginInput = z.infer<typeof agentPortalLoginSchema>;
