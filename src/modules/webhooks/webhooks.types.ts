/**
 * Webhook orchestration types.
 *
 * Merchants (and internal owners) subscribe to platform events. Every delivery
 * is HMAC-signed so the receiver can verify authenticity, and is retried with
 * exponential backoff until it succeeds or the attempt budget runs out.
 */

export const WEBHOOK_EVENTS = [
  "PAYMENT_RECEIVED",
  "PAYMENT_VALIDATED",
  "PAYMENT_POSTED",
  "PAYMENT_COMPLETED",
  "PAYMENT_SETTLED",
  "PAYMENT_REJECTED",
  "PAYMENT_FAILED",
  "AML_ALERT",
  "FRAUD_ALERT",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** The JSON body POSTed to a subscriber's callback URL. */
export interface WebhookPayload {
  event: WebhookEventName;
  eventId: string;
  reference: string | null;
  occurredAt: string;
  data: unknown;
}

/** A subscription as returned to callers — never includes the signing secret. */
export interface PublicWebhookSubscription {
  id: string;
  ownerType: string;
  merchantId: string | null;
  eventNames: string[];
  callbackUrl: string;
  description: string | null;
  secretLast4: string;
  active: boolean;
  maxAttempts: number;
  lastDeliveryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "EXHAUSTED";

/** Injectable HTTP client so delivery can be tested without real network calls. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;
