import { z } from "zod";

/**
 * Stripe SEPA Direct Debit Collection — Type Definitions
 *
 * Flow:
 *   1. POST /stripe/sepa/create-intent  → creates PaymentIntent (server)
 *   2. Browser confirms with Stripe.js  → sender enters IBAN + authorises mandate
 *   3. Stripe fires webhook             → payment_intent.succeeded
 *   4. Server credits VAULT:LOUIS-CALTEN:EUR via ledger
 */

export const createSepaIntentSchema = z.object({
  /** Amount in EUR cents (e.g. 50000 = €500.00) */
  amount:      z.number().int().min(100).max(50_000_000),
  /** Sender full name */
  senderName:  z.string().min(1).max(200).trim(),
  /** Sender email — Stripe sends mandate confirmation here */
  senderEmail: z.string().email().trim(),
  /** Optional payment reference / purpose */
  reference:   z.string().max(200).trim().optional(),
  /** Optional metadata */
  metadata:    z.record(z.string()).optional(),
});

export type CreateSepaIntentInput = z.infer<typeof createSepaIntentSchema>;

export const confirmSepaIntentSchema = z.object({
  paymentIntentId:    z.string().min(1),
  paymentMethodId:    z.string().min(1),
});

export type ConfirmSepaIntentInput = z.infer<typeof confirmSepaIntentSchema>;
