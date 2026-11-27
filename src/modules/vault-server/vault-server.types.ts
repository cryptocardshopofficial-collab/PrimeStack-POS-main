import { z } from "zod";

/**
 * Vault Server Module — Type Definitions
 *
 * The Vault Server is the platform's own private receiving server.
 * It has a unique identity (VSN), generates API keys per connected
 * bank account, exposes a receiving endpoint, and polls bank APIs
 * to auto-credit the vault ledger when funds arrive.
 */

// ── Vault Server Identity ────────────────────────────────────────

export const VAULT_SERVER_NODE_ID = "VSN-EP022162-PRIMESTACK";
export const VAULT_SERVER_VERSION = "1.0.0";

// ── Bank Connector ───────────────────────────────────────────────

/**
 * A bank connector links one of your real bank accounts to the vault.
 * When configured, the vault server polls the bank API and auto-credits
 * the vault ledger when new funds arrive.
 */
export const createVaultConnectorSchema = z.object({
  /** Human label — e.g. "Louis Calten USA — JPMorgan Chase" */
  label:            z.string().min(1).max(200),
  /** Which vault ledger account to credit — e.g. VAULT:LOUIS-CALTEN:USD */
  vaultAccountCode: z.string().min(1).max(100),
  /** Currency of this bank account */
  currency:         z.string().regex(/^[A-Z]{3}$/).default("USD"),
  /** Bank name for display */
  bankName:         z.string().min(1).max(200),
  /** Bank account number or IBAN */
  accountNumber:    z.string().min(1).max(100),
  /** SWIFT / BIC */
  swiftCode:        z.string().max(20).optional(),
  /** Account holder name */
  accountHolder:    z.string().min(1).max(200),
  /** Country code */
  country:          z.string().length(2).default("US"),
  /**
   * Bank API endpoint URL — the URL your bank provides to check balance
   * or receive webhook notifications. Optional — without it the connector
   * operates in manual-confirmation mode only.
   */
  bankApiEndpoint:  z.string().url().optional(),
  /**
   * Bank API key — encrypted at rest, never returned in responses.
   */
  bankApiKey:       z.string().min(8).max(500).optional(),
  /**
   * Polling interval in seconds (minimum 60). When set and bankApiEndpoint
   * is configured, the vault server polls this bank at this interval.
   */
  pollingIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  /** Whether auto-credit is enabled for this connector */
  autoCreditEnabled: z.boolean().default(false),
  metadata:         z.record(z.unknown()).optional(),
});

export const updateVaultConnectorSchema = createVaultConnectorSchema.partial().extend({
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
});

export type CreateVaultConnectorInput = z.infer<typeof createVaultConnectorSchema>;
export type UpdateVaultConnectorInput = z.infer<typeof updateVaultConnectorSchema>;

// ── Vault Receive ────────────────────────────────────────────────

/**
 * Payload sent to POST /vault/receive by an external system
 * (bank webhook, payment processor, or another private server).
 */
export const vaultReceiveSchema = z.object({
  /** Unique event ID from the sender — used for idempotency */
  eventId:          z.string().min(8).max(128),
  /** Amount received */
  amount:           z.union([z.string(), z.number()]).transform(String),
  /** Currency */
  currency:         z.string().regex(/^[A-Za-z]{3}$/).transform(s => s.toUpperCase()),
  /** Vault account to credit — e.g. VAULT:LOUIS-CALTEN:USD */
  vaultAccountCode: z.string().min(1).max(100),
  /** Name of the sender */
  senderName:       z.string().max(255).optional(),
  /** Sender bank or institution */
  senderBank:       z.string().max(255).optional(),
  /** Sender account reference */
  senderAccount:    z.string().max(128).optional(),
  /** Bank reference / wire reference */
  bankReference:    z.string().max(128).optional(),
  /** Value date ISO string */
  valueDate:        z.string().datetime().optional(),
  /** Transfer method */
  transferMethod:   z.string().max(50).optional(),
  metadata:         z.record(z.unknown()).optional(),
}).strict();

export type VaultReceiveInput = z.infer<typeof vaultReceiveSchema>;

// ── Vault Payout ─────────────────────────────────────────────────

export const vaultPayoutSchema = z.object({
  /** Source vault account */
  sourceVaultCode:   z.string().min(1).max(100),
  /** Amount */
  amount:            z.union([z.string(), z.number()]).transform(String),
  /** Currency */
  currency:          z.string().regex(/^[A-Za-z]{3}$/).transform(s => s.toUpperCase()),
  /** Destination type */
  destinationType:   z.enum(["BANK_ACCOUNT", "VAULT_ACCOUNT", "S2S_SERVER", "TERMINAL", "WALLET"]),
  /** Destination code / account */
  destinationCode:   z.string().min(1).max(200),
  /** Beneficiary name */
  beneficiaryName:   z.string().max(255).optional(),
  /** SWIFT / BIC for bank payouts */
  swiftCode:         z.string().max(20).optional(),
  /** Reference */
  reference:         z.string().min(1).max(128),
  /** Description */
  description:       z.string().max(500).optional(),
  /** Authorized by */
  authorizedBy:      z.string().max(200).optional(),
  metadata:          z.record(z.unknown()).optional(),
});

export type VaultPayoutInput = z.infer<typeof vaultPayoutSchema>;
