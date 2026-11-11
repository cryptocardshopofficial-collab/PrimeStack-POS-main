import { z } from "zod";

const appType = z.enum([
  "MERCHANT_APP",
  "TERMINAL_APP",
  "WALLET_APP",
  "TREASURY_APP",
  "PARTNER_APP",
]);

export const createApplicationSchema = z.object({
  appName: z.string().trim().min(1).max(255),
  ownerId: z.string().uuid(),
  appType,
  ratePlanId: z.string().uuid().optional(),
  productIds: z.array(z.string().uuid()).max(50).default([]),
});

export const updateApplicationSchema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "BLOCKED"]),
  ratePlanId: z.string().uuid().nullable().optional(),
  productIds: z.array(z.string().uuid()).max(50).optional(),
});

export const createProductSchema = z.object({
  productName: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional(),
  active: z.boolean().default(true),
});

export const createRatePlanSchema = z.object({
  planName: z.string().trim().min(1).max(100),
  requestsPerMinute: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .nullable()
    .optional(),
  dailyLimit: z.number().int().positive().max(2147483647).nullable().optional(),
});

export const createWebhookSchema = z.object({
  eventName: z.enum([
    "TRANSFER_APPROVED",
    "TRANSFER_FAILED",
    "WALLET_CREDITED",
    "SETTLEMENT_COMPLETED",
    "TERMINAL_ONLINE",
    "TERMINAL_OFFLINE",
  ]),
  callbackUrl: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "Webhook callback URL must use HTTPS"),
});

export const createSdkVersionSchema = z.object({
  sdkName: z.string().trim().min(1).max(100),
  language: z.enum(["NodeJS", "Java", "Go", "Python", ".NET", "PHP"]),
  version: z.string().trim().min(1).max(20),
});

export const createPartnerSchema = z.object({
  partnerName: z.string().trim().min(1).max(255),
  partnerType: z.enum([
    "BANK",
    "PROCESSOR",
    "AGGREGATOR",
    "MERCHANT",
    "TREASURY",
    "NETWORK",
  ]),
  active: z.boolean().default(true),
});

export const createCertificationSchema = z.object({
  applicationId: z.string().uuid(),
  certificationType: z.enum([
    "API_CERTIFICATION",
    "TERMINAL_CERTIFICATION",
    "MERCHANT_CERTIFICATION",
    "INTEGRATION_CERTIFICATION",
  ]),
});

export const updateCertificationSchema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "CERTIFIED", "REJECTED"]),
});

export const updateActiveSchema = z.object({
  active: z.boolean(),
});

export const createTerminalRegistrationSchema = z.object({
  agentCode: z.string().trim().min(1).max(100),
  customerName: z.string().trim().min(1).max(255),
  country: z.string().trim().min(1).max(100),
  senderPublicIp: z.string().trim().min(1).max(100),
  senderTerminalId: z.string().trim().min(1).max(100),
  senderServerUrl: z.string().trim().url().max(2048),
  operatingCurrency: z.string().trim().min(1).max(20),
  businessPurpose: z.string().trim().min(1).max(2000),
  customerMessage: z.string().trim().max(2000).optional().default(""),
});

export const createAgentTerminalRegistrationSchema =
  createTerminalRegistrationSchema.omit({ agentCode: true });

export const createAgentRegistrationSchema = z.object({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50),
  country: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(1000),
  documentNumber: z.string().trim().min(1).max(100),
  commissionRate: z.number().min(0).max(100).optional(),
});

export const updateAgentRegistrationSchema = z.object({
  status: z.enum(["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED"]),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
